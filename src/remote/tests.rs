use super::*;
use axum::{Form, Json, Router, extract::State, routing::post};
use oxigraph::sparql::QueryResults;
use std::sync::atomic::AtomicBool;

fn fixture() -> Dataset {
    let mut rdf = String::from(
        "@prefix e: <https://example/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . e:root rdfs:label \"Root\" . e:back e:mentions e:root .\n",
    );
    for n in 0..137 {
        rdf.push_str(&format!("e:g {{ e:root e:links e:n{n:03} . e:n{n:03} rdfs:label \"Discovery {n:03}\" ; a e:Book . }}\n"));
    }
    rdf.push_str("e:root e:default e:leaf . e:h { e:root e:links e:n000 . } e:root e:blank [ rdfs:label \"Nested\" ] .");
    Dataset::parse(rdf.as_bytes(), "fixture.trig", "file").unwrap()
}
fn execute(store: &Store, query: &str) -> Value {
    let QueryResults::Solutions(rows) = SparqlEvaluator::new()
        .parse_query(query)
        .unwrap()
        .on_store(store)
        .execute()
        .unwrap()
    else {
        panic!("expected SELECT")
    };
    let vars: Vec<_> = rows
        .variables()
        .iter()
        .map(|v| v.as_str().to_owned())
        .collect();
    let rows:Vec<_>=rows.map(|row| {
        row.unwrap().iter().map(|(v,t)| {
            let term=match t {
                Term::NamedNode(n)=>json!({"type":"uri","value":n.as_str()}),
                Term::BlankNode(n)=>json!({"type":"bnode","value":n.as_str()}),
                Term::Literal(l)=>{let mut value=json!({"type":"literal","value":l.value(),"datatype":l.datatype().as_str()});if let Some(lang)=l.language(){value["xml:lang"]=json!(lang);}value},
            };
            (v.as_str().to_owned(),term)
        }).collect::<serde_json::Map<_,_>>()
    }).collect();
    json!({"head":{"vars":vars},"results":{"bindings":rows}})
}
#[test]
fn generated_queries_execute_and_preserve_scope() {
    let ds = fixture();
    let mut p = PageRequest {
        id: "https://example/root".into(),
        direction: Direction::Outgoing,
        predicate: "https://example/links".into(),
        graph: String::new(),
        offset: 0,
        limit: 25,
    };
    let mut seen = BTreeSet::new();
    loop {
        let json = execute(&ds.store, &neighborhood_query(&p).unwrap());
        let rows = json["results"]["bindings"].as_array().unwrap();
        for row in rows.iter().take(25) {
            assert!(seen.insert((
                row["o"]["value"].as_str().unwrap().to_owned(),
                row["g"]["value"].as_str().unwrap().to_owned()
            )));
        }
        if rows.len() <= 25 {
            break;
        }
        p.offset += 25;
    }
    assert_eq!(seen.len(), 138);
    p.offset = 0;
    p.graph = "https://example/h".into();
    assert_eq!(
        execute(&ds.store, &neighborhood_query(&p).unwrap())["results"]["bindings"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    p.predicate.clear();
    p.graph = "default".into();
    p.direction = Direction::Incoming;
    assert_eq!(
        execute(&ds.store, &neighborhood_query(&p).unwrap())["results"]["bindings"][0]["s"]["value"],
        "https://example/back"
    );
    for (text, class, expected) in [
        ("Discovery 136", "", 1),
        ("Discovery", "https://example/Book", 26),
        ("Discovery", "https://example/Other", 0),
        ("leaf", "", 1),
        ("\" } UNION { ?x ?y ?z } #", "", 0),
    ] {
        let q = search_query(&SearchRequest {
            q: text.into(),
            class: class.into(),
            offset: 0,
            limit: 25,
        })
        .unwrap();
        assert_eq!(
            execute(&ds.store, &q)["results"]["bindings"]
                .as_array()
                .unwrap()
                .len(),
            expected,
            "{text}"
        );
    }
}
#[tokio::test]
async fn endpoint_exploration_hydrates_labels_and_records_failures() {
    #[derive(Clone)]
    struct Fixture {
        store: Store,
        fail_metadata: Arc<AtomicBool>,
    }
    async fn handler(
        State(f): State<Fixture>,
        headers: axum::http::HeaderMap,
        Form(params): Form<BTreeMap<String, String>>,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        assert_eq!(headers["authorization"], "Bearer fixture-secret");
        let query = &params["query"];
        if f.fail_metadata.load(Ordering::Relaxed) && query.contains("VALUES ?s") {
            return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        Json(execute(&f.store, query)).into_response()
    }
    let fixture = Fixture {
        store: fixture().store,
        fail_metadata: Arc::new(AtomicBool::new(false)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/sparql?private=hidden",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/sparql", post(handler))
                .with_state(fixture.clone()),
        )
        .into_future(),
    );
    let remote = Remote::new(url, Some("fixture-secret".into())).unwrap();
    let previous = Dataset::parse(b"", "empty.ttl", "file").unwrap();
    let p = PageRequest {
        id: "https://example/root".into(),
        direction: Direction::Outgoing,
        predicate: "https://example/links".into(),
        graph: String::new(),
        offset: 125,
        limit: 25,
    };
    let (ds, page) = remote.neighborhood(&p, &previous).await.unwrap();
    assert!(!page.has_more);
    assert_eq!(page.statements.len(), 13);
    let target = page
        .graph
        .nodes
        .iter()
        .find(|n| n.id == "https://example/n136")
        .unwrap();
    assert_eq!(target.label, "Discovery 136");
    assert_eq!(target.types, vec!["https://example/Book"]);
    let groups = remote.groups(&p).await.unwrap();
    assert_eq!(
        groups
            .groups
            .iter()
            .find(|g| g.predicate == "https://example/links")
            .unwrap()
            .count,
        138
    );
    assert!(
        groups
            .groups
            .iter()
            .any(|g| g.direction == "incoming" && g.count == 1)
    );
    let found = remote
        .search(&SearchRequest {
            q: "Discovery 136".into(),
            class: String::new(),
            offset: 0,
            limit: 25,
        })
        .await
        .unwrap();
    assert_eq!(found.items[0].label, "Discovery 136");
    let (inspected, more) = remote.inspect("https://example/n136", &ds).await.unwrap();
    assert!(!more);
    assert_eq!(
        inspected
            .detail("https://example/n136")
            .unwrap()
            .resource
            .label,
        "Discovery 136"
    );
    fixture.fail_metadata.store(true, Ordering::Relaxed);
    let (_, page) = remote.neighborhood(&p, &previous).await.unwrap();
    assert_eq!(page.statements.len(), 13);
    assert_eq!(page.warnings.len(), 1);
    let log = remote.traces();
    assert_eq!(log[0].status, "error");
    assert_eq!(log[0].http_status, Some(503));
    let serialized = serde_json::to_string(&log).unwrap();
    assert!(!serialized.contains("fixture-secret"));
    assert!(!serialized.contains("private=hidden"));
    remote.clear_traces();
    assert!(remote.traces().is_empty());
    server.abort();
}
