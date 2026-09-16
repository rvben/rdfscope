use oxigraph::{io::RdfFormat, model::*, sparql::SparqlEvaluator, store::Store};
use rdfscope::dataset::{Dataset, RDF_TYPE, RdfTerm, Resource, Result, Statement, short};
use rdfscope::exploration::{
    self, Direction, Groups, Page, PageRequest, RelationGroup, SearchPage, SearchRequest,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static BATCH: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
pub struct QueryTrace {
    pub id: u64,
    pub started_at: u64,
    pub purpose: String,
    pub endpoint: String,
    pub query: String,
    pub elapsed_ms: u128,
    pub status: String,
    pub http_status: Option<u16>,
    pub bytes: usize,
    pub rows: Option<usize>,
    pub error: Option<String>,
}
#[derive(Default)]
struct TraceLog {
    next: u64,
    entries: VecDeque<QueryTrace>,
}
#[derive(Clone)]
pub struct Remote {
    pub url: String,
    pub token: Option<String>,
    client: reqwest::Client,
    traces: Arc<Mutex<TraceLog>>,
    slots: Arc<tokio::sync::Semaphore>,
}
impl Remote {
    pub fn new(url: String, token: Option<String>) -> Result<Self> {
        let parsed = reqwest::Url::parse(&url)
            .map_err(|_| "Enter a complete http:// or https:// SPARQL endpoint URL.")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("Use an HTTP(S) endpoint without embedded credentials. Use the token field for authentication.".into());
        }
        Ok(Self {
            url,
            token: token.filter(|t| !t.is_empty()),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(25))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("RDFscope/0.1")
                .build()
                .map_err(|e| e.to_string())?,
            traces: Arc::new(Mutex::new(TraceLog::default())),
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
        })
    }

    pub fn traces(&self) -> Vec<QueryTrace> {
        self.traces
            .lock()
            .unwrap()
            .entries
            .iter()
            .rev()
            .cloned()
            .collect()
    }
    pub fn clear_traces(&self) {
        self.traces.lock().unwrap().entries.clear();
    }
    async fn request(&self, purpose: &str, query: &str) -> Result<(String, Vec<u8>)> {
        let _slot = tokio::time::timeout(Duration::from_secs(5), self.slots.acquire())
            .await
            .map_err(|_| "The endpoint is busy. Wait for an active request and retry.")?
            .map_err(|_| "Endpoint connection closed.")?;
        let start = Instant::now();
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut status = None;
        let mut bytes = 0;
        let result = self.request_raw(query, &mut status, &mut bytes).await;
        let rows = result
            .as_ref()
            .ok()
            .and_then(|(_, body)| serde_json::from_slice::<Value>(body).ok())
            .and_then(|json| {
                json.pointer("/results/bindings")
                    .and_then(Value::as_array)
                    .map(Vec::len)
            });
        let mut endpoint = reqwest::Url::parse(&self.url).unwrap();
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        let mut log = self.traces.lock().unwrap();
        log.next += 1;
        let id = log.next;
        log.entries.push_back(QueryTrace {
            id,
            started_at,
            purpose: purpose.into(),
            endpoint: endpoint.to_string(),
            query: query.into(),
            elapsed_ms: start.elapsed().as_millis(),
            status: if result.is_ok() { "ok" } else { "error" }.into(),
            http_status: status,
            bytes,
            rows,
            error: result.as_ref().err().cloned(),
        });
        while log.entries.len() > 50 {
            log.entries.pop_front();
        }
        result
    }
    async fn request_raw(
        &self,
        query: &str,
        status: &mut Option<u16>,
        bytes: &mut usize,
    ) -> Result<(String, Vec<u8>)> {
        // A read-only parser gate also prevents SPARQL Update requests to remote stores.
        let _ = SparqlEvaluator::new()
            .parse_query(query)
            .map_err(|e| e.to_string())?;
        let mut request = self
            .client
            .post(&self.url)
            .header(
                "accept",
                "application/sparql-results+json, text/turtle;q=0.9",
            )
            .form(&[("query", query)]);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let mut response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                "The endpoint did not respond within 25 seconds. Try a smaller query.".into()
            } else {
                "Could not reach the endpoint. Check its URL and network connection.".to_owned()
            }
        })?;
        *status = Some(response.status().as_u16());
        if !response.status().is_success() {
            return Err(format!(
                "Endpoint returned HTTP {}. Check the URL, credentials, and query.",
                response.status().as_u16()
            ));
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let mut data = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "The endpoint response was interrupted.")?
        {
            if data.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("Endpoint response exceeds 8 MB. Add a smaller LIMIT.".into());
            }
            data.extend_from_slice(&chunk);
            *bytes = data.len();
        }
        if !content_type.contains("turtle") && !content_type.contains("n-triples") {
            let value: Value = serde_json::from_slice(&data)
                .map_err(|_| "Endpoint did not return SPARQL JSON results.")?;
            if value.get("boolean").and_then(Value::as_bool).is_none()
                && (value
                    .pointer("/results/bindings")
                    .and_then(Value::as_array)
                    .is_none()
                    || value
                        .pointer("/head/vars")
                        .and_then(Value::as_array)
                        .is_none())
            {
                return Err(
                    "Endpoint response is missing SPARQL result bindings or variables.".into(),
                );
            }
        }
        Ok((content_type, data))
    }

    pub async fn fetch(&self, center: Option<&str>, previous: Option<&Dataset>) -> Result<Dataset> {
        let pattern = if let Some(id) = center {
            if id.starts_with("_:") {
                return Err("Blank-node identifiers only apply to their original response. Explore them in the cached data.".into());
            }
            let iri = NamedNode::new(id).map_err(|_| "Enter a valid resource IRI.")?;
            format!("{{ BIND({iri} AS ?s) ?s ?p ?o }} UNION {{ ?s ?p {iri} BIND({iri} AS ?o) }}")
        } else {
            "?s ?p ?o".into()
        };
        let query = format!(
            "SELECT DISTINCT ?s ?p ?o ?g WHERE {{ {{ {pattern} }} UNION {{ GRAPH ?g {{ {pattern} }} }} }} LIMIT 500"
        );
        let (_, bytes) = self.request("Initial sample", &query).await?;
        let json: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Endpoint did not return SPARQL JSON results.")?;
        let rows = json
            .pointer("/results/bindings")
            .and_then(Value::as_array)
            .ok_or("Endpoint response is missing SPARQL bindings.")?;
        let store = Store::new().map_err(|e| e.to_string())?;
        if let Some(previous) = previous {
            for q in previous.store.iter() {
                store
                    .insert(&q.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            }
        }
        // Scope blank nodes to this result document; IDs from separate responses cannot be equated.
        let batch = BATCH.fetch_add(1, Ordering::Relaxed);
        for row in rows {
            let subject: NamedOrBlankNode = term(&row["s"], batch)?
                .try_into()
                .map_err(|_| "Invalid RDF subject in endpoint response.")?;
            let predicate = match term(&row["p"], batch)? {
                Term::NamedNode(n) => n,
                _ => return Err("Invalid RDF predicate in endpoint response.".into()),
            };
            let object = term(&row["o"], batch)?;
            let graph = if row.get("g").is_some() {
                match term(&row["g"], batch)? {
                    Term::NamedNode(n) => GraphName::NamedNode(n),
                    Term::BlankNode(n) => GraphName::BlankNode(n),
                    _ => return Err("Invalid graph name.".into()),
                }
            } else {
                GraphName::DefaultGraph
            };
            store
                .insert(&Quad::new(subject, predicate, object, graph))
                .map_err(|e| e.to_string())?;
        }
        let host = reqwest::Url::parse(&self.url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or("SPARQL endpoint".into());
        Dataset::index(store, host, "endpoint".into(), Some(self.url.clone()))
    }

    pub async fn neighborhood(
        &self,
        p: &PageRequest,
        previous: &Dataset,
    ) -> Result<(Dataset, Page)> {
        p.validate()?;
        if p.id.starts_with("_:") {
            return Ok((
                merge_dataset(self, Some(previous), &[])?,
                previous.connection_page(p)?,
            ));
        }
        let query = neighborhood_query(p)?;
        let (_, bytes) = self.request("Browse connections", &query).await?;
        let mut quads = parse_quads(&bytes)?;
        let has_more = quads.len() > p.limit;
        quads.truncate(p.limit);
        let statements: Vec<_> = quads.iter().map(statement).collect();
        let mut ids = BTreeSet::from([p.id.clone()]);
        for q in &quads {
            ids.insert(q.subject.to_string().trim_matches(['<', '>']).to_owned());
            if let Term::NamedNode(n) = &q.object {
                ids.insert(n.as_str().into());
            }
            ids.insert(q.predicate.as_str().into());
        }
        let (metadata, mut warnings) = self.metadata(&ids).await;
        if statements
            .iter()
            .any(|s| s.subject.starts_with("_:") || s.object.kind == "bnode")
        {
            warnings.push("Blank nodes belong to this response. Fetching the page again may create separate cached nodes.".into());
        }
        quads.extend(metadata);
        let mut ds = merge_dataset(self, Some(previous), &quads)?;
        ensure_resource(&mut ds, &p.id);
        let next = p.offset + statements.len();
        let page = Page {
            graph: exploration::page_graph(&ds, &p.id, &statements),
            statements,
            offset: p.offset,
            has_more,
            next_offset: has_more.then_some(next),
            total: None,
            scope: "endpoint",
            warnings,
        };
        Ok((ds, page))
    }
    pub async fn groups(&self, p: &PageRequest) -> Result<Groups> {
        p.validate()?;
        let id = exploration::iri(&p.id)?;
        let pattern = format!(
            "{{ BIND({id} AS ?s) ?s ?p ?o BIND(\"outgoing\" AS ?direction) }} UNION {{ ?s ?p {id} BIND({id} AS ?o) BIND(\"incoming\" AS ?direction) }}"
        );
        let scope = graph_pattern(&pattern, &p.graph)?;
        let query = format!(
            "SELECT ?p ?direction (COUNT(*) AS ?count) WHERE {{ {scope} FILTER(!isLiteral(?o) && ?p != <{RDF_TYPE}>) }} GROUP BY ?p ?direction ORDER BY STR(?p) ?direction LIMIT 201"
        );
        let (_, bytes) = self.request("Relationship counts", &query).await?;
        let rows = bindings(&bytes)?;
        let has_more = rows.len() > 200;
        let mut groups = vec![];
        for row in rows.into_iter().take(200) {
            let predicate = row["p"]["value"]
                .as_str()
                .ok_or("Missing predicate in relationship counts.")?
                .to_owned();
            let count = row["count"]["value"]
                .as_str()
                .and_then(|n| n.parse().ok())
                .ok_or("Invalid relationship count.")?;
            let direction = match row["direction"]["value"].as_str() {
                Some("outgoing") => "outgoing",
                Some("incoming") => "incoming",
                _ => return Err("Invalid relationship direction.".into()),
            };
            groups.push(RelationGroup {
                label: short(&predicate),
                predicate,
                count,
                direction,
            });
        }
        Ok(Groups {
            groups,
            has_more,
            scope: "endpoint",
        })
    }
    async fn metadata(&self, ids: &BTreeSet<String>) -> (Vec<Quad>, Vec<String>) {
        let values: Vec<_> = ids
            .iter()
            .filter(|id| !id.starts_with("_:"))
            .filter_map(|id| NamedNode::new(id.as_str()).ok())
            .map(|n| n.to_string())
            .collect();
        if values.is_empty() {
            return (vec![], vec![]);
        }
        let predicates = rdfscope::dataset::LABELS
            .iter()
            .copied()
            .chain([RDF_TYPE])
            .map(|p| format!("<{p}>"))
            .collect::<Vec<_>>()
            .join(" ");
        let query = format!(
            "SELECT DISTINCT ?s ?p ?o ?g WHERE {{ VALUES ?s {{ {} }} VALUES ?p {{ {predicates} }} {{ ?s ?p ?o }} UNION {{ GRAPH ?g {{ ?s ?p ?o }} }} }} ORDER BY ?s ?p ?o ?g LIMIT 2001",
            values.join(" ")
        );
        match self.request("Labels and types",&query).await.and_then(|(_,bytes)|parse_quads(&bytes)) {
            Ok(mut rows)=>{let mut warnings=vec![];if rows.len()>2000 {rows.truncate(2000);warnings.push("Some labels and types were omitted by the metadata limit.".into());}(rows,warnings)},
            Err(_)=>(vec![],vec!["Resources were retrieved, but labels and types could not be loaded. See the query trace for details.".into()]),
        }
    }
    pub async fn search(&self, p: &SearchRequest) -> Result<SearchPage> {
        p.validate()?;
        if p.q.trim().chars().count() < 2 && p.class.is_empty() {
            return Ok(SearchPage {
                items: vec![],
                has_more: false,
                next_offset: None,
                scope: "endpoint",
                warnings: vec![],
            });
        }
        let query = search_query(p)?;
        let (_, bytes) = self.request("Find resources", &query).await?;
        let rows = bindings(&bytes)?;
        let has_more = rows.len() > p.limit;
        let mut ids = vec![];
        for row in rows.into_iter().take(p.limit) {
            if row["id"]["type"] != "uri" {
                return Err("Endpoint search returned a non-IRI resource.".into());
            }
            ids.push(
                row["id"]["value"]
                    .as_str()
                    .ok_or("Search result has no IRI.")?
                    .to_owned(),
            );
        }
        let (metadata, warnings) = self.metadata(&ids.iter().cloned().collect()).await;
        let mut ds = merge_dataset(self, None, &metadata)?;
        for id in &ids {
            ensure_resource(&mut ds, id);
        }
        let items = ids
            .iter()
            .filter_map(|id| ds.resources.get(id).cloned())
            .collect();
        Ok(SearchPage {
            items,
            has_more,
            next_offset: has_more.then_some(p.offset + ids.len()),
            scope: "endpoint",
            warnings,
        })
    }
    pub async fn inspect(&self, id: &str, previous: &Dataset) -> Result<(Dataset, bool)> {
        let iri = exploration::iri(id)?;
        let query = format!(
            "SELECT DISTINCT ?s ?p ?o ?g WHERE {{ BIND({iri} AS ?s) {{ ?s ?p ?o }} UNION {{ GRAPH ?g {{ ?s ?p ?o }} }} FILTER(isLiteral(?o) || ?p=<{RDF_TYPE}>) }} ORDER BY STR(?p) STR(?o) LANG(?o) STR(DATATYPE(?o)) STR(?g) LIMIT 301"
        );
        let (_, bytes) = self.request("Inspect properties", &query).await?;
        let mut quads = parse_quads(&bytes)?;
        let more = quads.len() > 300;
        quads.truncate(300);
        let mut ds = merge_dataset(self, Some(previous), &quads)?;
        ensure_resource(&mut ds, id);
        Ok((ds, more))
    }
    pub async fn query(&self, query: &str) -> Result<Value> {
        let (content_type, bytes) = self.request("SPARQL query", query).await?;
        if content_type.contains("turtle") || content_type.contains("n-triples") {
            let format = if content_type.contains("n-triples") {
                RdfFormat::NTriples
            } else {
                RdfFormat::Turtle
            };
            let store = Store::new().map_err(|e| e.to_string())?;
            store
                .load_from_slice(format, &bytes)
                .map_err(|e| e.to_string())?;
            let ds = Dataset::index(store, "Query result".into(), "file".into(), None)?;
            return ds
                .query("SELECT ?subject ?predicate ?object WHERE { ?subject ?predicate ?object }");
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Expected SPARQL JSON or Turtle from the endpoint.")?;
        if let Some(value) = value.get("boolean").and_then(Value::as_bool) {
            return Ok(json!({"kind":"boolean","value":value}));
        }
        let columns = value
            .pointer("/head/vars")
            .and_then(Value::as_array)
            .ok_or("Endpoint response is missing variables.")?;
        let bindings = value
            .pointer("/results/bindings")
            .and_then(Value::as_array)
            .ok_or("Endpoint response is missing bindings.")?;
        let batch = BATCH.fetch_add(1, Ordering::Relaxed);
        let mut rows = vec![];
        for binding in bindings.iter().take(1000) {
            let mut row = BTreeMap::new();
            for column in columns.iter().filter_map(Value::as_str) {
                if let Some(value) = binding.get(column) {
                    row.insert(column, RdfTerm::from_term(&term(value, batch)?));
                }
            }
            rows.push(row);
        }
        Ok(
            json!({"kind":"bindings", "columns": columns, "rows":rows, "truncated":bindings.len() > 1000}),
        )
    }
}

fn graph_pattern(pattern: &str, graph: &str) -> Result<String> {
    Ok(if graph.is_empty() {
        format!("{{ {pattern} }} UNION {{ GRAPH ?g {{ {pattern} }} }}")
    } else if graph == "default" {
        format!("{{ {pattern} }}")
    } else {
        let iri = exploration::iri(graph)?;
        format!("GRAPH {iri} {{ {pattern} }} BIND({iri} AS ?g)")
    })
}
fn neighborhood_query(p: &PageRequest) -> Result<String> {
    p.validate()?;
    let id = exploration::iri(&p.id)?;
    let pattern = match p.direction {
        Direction::Both => {
            format!("{{ BIND({id} AS ?s) ?s ?p ?o }} UNION {{ ?s ?p {id} BIND({id} AS ?o) }}")
        }
        Direction::Outgoing => format!("BIND({id} AS ?s) ?s ?p ?o"),
        Direction::Incoming => format!("?s ?p {id} BIND({id} AS ?o)"),
    };
    let scope = graph_pattern(&pattern, &p.graph)?;
    let filter = if p.predicate.is_empty() {
        String::new()
    } else {
        format!("FILTER(?p={})", exploration::iri(&p.predicate)?)
    };
    Ok(format!(
        "SELECT DISTINCT ?s ?p ?o ?g WHERE {{ {scope} FILTER(!isLiteral(?o) && ?p != <{RDF_TYPE}>) {filter} }} ORDER BY STR(?p) STR(?s) isBlank(?o) STR(?o) STR(?g) ?s ?o ?g LIMIT {} OFFSET {}",
        p.limit + 1,
        p.offset
    ))
}
fn search_query(p: &SearchRequest) -> Result<String> {
    let candidate = "{ ?id ?any ?value } UNION { ?subject ?any ?id }";
    let scope = graph_pattern(candidate, "")?;
    let text = Literal::new_simple_literal(p.q.trim().to_lowercase());
    let predicates = rdfscope::dataset::LABELS
        .iter()
        .map(|p| format!("<{p}>"))
        .collect::<Vec<_>>()
        .join(" ");
    let label = format!(
        "VALUES ?labelProperty {{ {predicates} }} {{ ?id ?labelProperty ?label }} UNION {{ GRAPH ?labelGraph {{ ?id ?labelProperty ?label }} }} FILTER(isLiteral(?label) && CONTAINS(LCASE(STR(?label)), {text}))"
    );
    let type_filter = if p.class.is_empty() {
        String::new()
    } else {
        let ty = exploration::iri(&p.class)?;
        format!(
            "FILTER EXISTS {{ {{ ?id a {ty} }} UNION {{ GRAPH ?typeGraph {{ ?id a {ty} }} }} }}"
        )
    };
    Ok(format!(
        "SELECT DISTINCT ?id WHERE {{ {scope} FILTER(isIRI(?id)) {type_filter} FILTER(CONTAINS(LCASE(STR(?id)), {text}) || EXISTS {{ {label} }}) }} ORDER BY STR(?id) LIMIT {} OFFSET {}",
        p.limit + 1,
        p.offset
    ))
}
fn bindings(bytes: &[u8]) -> Result<Vec<Value>> {
    let json: Value = serde_json::from_slice(bytes)
        .map_err(|_| "Endpoint did not return SPARQL JSON results.")?;
    json.pointer("/results/bindings")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Endpoint response is missing SPARQL bindings.".into())
}
fn parse_quads(bytes: &[u8]) -> Result<Vec<Quad>> {
    let batch = BATCH.fetch_add(1, Ordering::Relaxed);
    bindings(bytes)?
        .iter()
        .map(|row| {
            let s: NamedOrBlankNode = term(&row["s"], batch)?
                .try_into()
                .map_err(|_| "Invalid RDF subject.")?;
            let p = match term(&row["p"], batch)? {
                Term::NamedNode(n) => n,
                _ => return Err("Invalid RDF predicate.".into()),
            };
            let o = term(&row["o"], batch)?;
            let g = match row.get("g") {
                None => GraphName::DefaultGraph,
                Some(value) => match term(value, batch)? {
                    Term::NamedNode(n) => GraphName::NamedNode(n),
                    Term::BlankNode(n) => GraphName::BlankNode(n),
                    _ => return Err("Invalid graph name.".into()),
                },
            };
            Ok(Quad::new(s, p, o, g))
        })
        .collect()
}
fn statement(q: &Quad) -> Statement {
    Statement {
        subject: match &q.subject {
            NamedOrBlankNode::NamedNode(n) => n.as_str().into(),
            NamedOrBlankNode::BlankNode(n) => format!("_:{}", n.as_str()),
        },
        predicate: q.predicate.as_str().into(),
        object: RdfTerm::from_term(&q.object),
        graph: match &q.graph_name {
            GraphName::DefaultGraph => "default".into(),
            GraphName::NamedNode(n) => n.as_str().into(),
            GraphName::BlankNode(n) => format!("_:{}", n.as_str()),
        },
    }
}
fn ensure_resource(ds: &mut Dataset, id: &str) {
    ds.resources.entry(id.into()).or_insert_with(|| Resource {
        id: id.into(),
        label: short(id),
        types: vec![],
        description: None,
        degree: 0,
        is_class: false,
    });
}
fn merge_dataset(remote: &Remote, previous: Option<&Dataset>, quads: &[Quad]) -> Result<Dataset> {
    let store = Store::new().map_err(|e| e.to_string())?;
    if let Some(previous) = previous {
        for quad in previous.store.iter() {
            store
                .insert(&quad.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
    }
    for quad in quads {
        store.insert(quad).map_err(|e| e.to_string())?;
    }
    let name = reqwest::Url::parse(&remote.url)
        .unwrap()
        .host_str()
        .unwrap_or("SPARQL endpoint")
        .to_owned();
    Dataset::index(store, name, "endpoint".into(), Some(remote.url.clone()))
}

fn term(value: &Value, batch: u64) -> Result<Term> {
    let text = value["value"].as_str().ok_or("RDF term has no value.")?;
    match value["type"].as_str() {
        Some("uri") => Ok(NamedNode::new(text).map_err(|e| e.to_string())?.into()),
        Some("bnode") => {
            // Hex encoding is reversible and cannot introduce invalid blank-node characters.
            let encoded: String = text.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
            Ok(BlankNode::new(format!("r{batch}n{encoded}"))
                .map_err(|e| e.to_string())?
                .into())
        }
        Some("literal" | "typed-literal") => {
            let literal = if let Some(lang) = value["xml:lang"].as_str() {
                Literal::new_language_tagged_literal(text, lang).map_err(|e| e.to_string())?
            } else if let Some(datatype) = value["datatype"].as_str() {
                Literal::new_typed_literal(
                    text,
                    NamedNode::new(datatype).map_err(|e| e.to_string())?,
                )
            } else {
                Literal::new_simple_literal(text)
            };
            Ok(literal.into())
        }
        _ => Err("Unsupported RDF term in endpoint response.".into()),
    }
}

#[cfg(test)]
mod basic_tests {
    use super::*;
    #[test]
    fn blank_nodes_are_scoped_to_the_response() {
        let value = json!({"type":"bnode", "value":"b1"});
        assert_eq!(term(&value, 1).unwrap(), term(&value, 1).unwrap());
        assert_ne!(term(&value, 1).unwrap(), term(&value, 2).unwrap());
        assert!(Remote::new("file:///etc/passwd".into(), None).is_err());
        assert!(Remote::new("https://user:secret@example.org/sparql".into(), None).is_err());
    }
}

#[cfg(test)]
mod tests;
