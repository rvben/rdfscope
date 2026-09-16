use oxigraph::{
    io::{RdfFormat, RdfParser},
    model::{GraphName, Term},
    sparql::{CancellationToken, QueryResults, SparqlEvaluator},
    store::Store,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const LABELS: &[&str] = &[
    "http://www.w3.org/2000/01/rdf-schema#label",
    "http://www.w3.org/2004/02/skos/core#prefLabel",
    "https://schema.org/name",
    "http://schema.org/name",
    "http://xmlns.com/foaf/0.1/name",
    "http://purl.org/dc/terms/title",
];
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct RdfTerm {
    pub kind: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub datatype: Option<String>,
}
impl RdfTerm {
    pub fn from_term(term: &Term) -> Self {
        match term {
            Term::NamedNode(n) => Self::resource(n.as_str()),
            Term::BlankNode(n) => Self::resource(&format!("_:{}", n.as_str())),
            Term::Literal(l) => Self {
                kind: "literal".into(),
                value: l.value().into(),
                language: l.language().map(str::to_owned),
                datatype: Some(l.datatype().as_str().into()),
            },
        }
    }
    pub fn resource(id: &str) -> Self {
        Self {
            kind: if id.starts_with("_:") { "bnode" } else { "uri" }.into(),
            value: id.into(),
            language: None,
            datatype: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Statement {
    pub subject: String,
    pub predicate: String,
    pub object: RdfTerm,
    pub graph: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Resource {
    pub id: String,
    pub label: String,
    pub types: Vec<String>,
    pub description: Option<String>,
    pub degree: usize,
    pub is_class: bool,
}

#[derive(Clone, Serialize)]
pub struct Facet {
    pub id: String,
    pub label: String,
    pub count: usize,
}

#[derive(Clone, Serialize)]
pub struct Summary {
    pub name: String,
    pub source: String,
    pub endpoint: Option<String>,
    pub triples: usize,
    pub resources: usize,
    pub relationships: usize,
    pub classes: Vec<Facet>,
    pub predicates: Vec<Facet>,
    pub graphs: Vec<Facet>,
    pub sampled: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub predicate: String,
    pub label: String,
    pub graph: String,
}

#[derive(Serialize)]
pub struct Graph {
    pub nodes: Vec<Resource>,
    pub edges: Vec<Edge>,
    pub total: usize,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct Detail {
    pub resource: Resource,
    pub outgoing: Vec<Statement>,
    pub incoming: Vec<Statement>,
    pub outgoing_total: usize,
    pub incoming_total: usize,
}

pub struct Dataset {
    pub store: Store,
    pub summary: Summary,
    pub resources: BTreeMap<String, Resource>,
    pub statements: Vec<Statement>,
    pub outgoing: HashMap<String, Vec<usize>>,
    pub incoming: HashMap<String, Vec<usize>>,
}

pub fn short(id: &str) -> String {
    id.rsplit(['#', '/'])
        .find(|s| !s.is_empty())
        .unwrap_or(id)
        .replace('_', " ")
}

impl Dataset {
    pub fn parse(bytes: &[u8], filename: &str, source: &str) -> Result<Self> {
        let extension = filename
            .rsplit('.')
            .next()
            .unwrap_or("ttl")
            .to_ascii_lowercase();
        let format = match extension.as_str() {
            "ttl" | "turtle" => RdfFormat::Turtle,
            "trig" => RdfFormat::TriG,
            "nt" => RdfFormat::NTriples,
            "nq" => RdfFormat::NQuads,
            "rdf" | "xml" => RdfFormat::RdfXml,
            "jsonld" | "json" => RdfFormat::JsonLd {
                profile: Default::default(),
            },
            _ => return Err("Choose a .ttl, .trig, .nt, .nq, .rdf, or .jsonld file.".into()),
        };
        let store = Store::new().map_err(|e| e.to_string())?;
        let parser = RdfParser::from_format(format)
            .with_base_iri("https://rdfscope.local/import/")
            .map_err(|e| e.to_string())?;
        store
            .load_from_slice(parser, bytes)
            .map_err(|e| format!("Could not parse {filename}: {e}"))?;
        Self::index(store, filename.into(), source.into(), None)
    }

    pub fn index(
        store: Store,
        name: String,
        source: String,
        endpoint: Option<String>,
    ) -> Result<Self> {
        let mut resources: BTreeMap<String, Resource> = BTreeMap::new();
        let mut statements = Vec::new();
        let mut outgoing: HashMap<String, Vec<usize>> = HashMap::new();
        let mut incoming: HashMap<String, Vec<usize>> = HashMap::new();
        let mut classes: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut predicates: BTreeMap<String, usize> = BTreeMap::new();
        let mut graphs: BTreeMap<String, usize> = BTreeMap::new();
        let mut labels: HashMap<String, (usize, String)> = HashMap::new();
        let mut relationships = 0;
        for quad in store.iter() {
            let q = quad.map_err(|e| e.to_string())?;
            let subject = match &q.subject {
                oxigraph::model::NamedOrBlankNode::NamedNode(n) => n.as_str().to_owned(),
                oxigraph::model::NamedOrBlankNode::BlankNode(n) => format!("_:{}", n.as_str()),
            };
            let object = RdfTerm::from_term(&q.object);
            let predicate = q.predicate.as_str().to_owned();
            let graph = match q.graph_name {
                GraphName::NamedNode(n) => n.as_str().into(),
                GraphName::BlankNode(n) => format!("_:{}", n.as_str()),
                GraphName::DefaultGraph => "default".into(),
            };
            let index = statements.len();
            outgoing.entry(subject.clone()).or_default().push(index);
            resources
                .entry(subject.clone())
                .or_insert_with(|| Resource {
                    id: subject.clone(),
                    label: short(&subject),
                    types: vec![],
                    description: None,
                    degree: 0,
                    is_class: false,
                });
            if object.kind != "literal" {
                incoming
                    .entry(object.value.clone())
                    .or_default()
                    .push(index);
                resources
                    .entry(object.value.clone())
                    .or_insert_with(|| Resource {
                        id: object.value.clone(),
                        label: short(&object.value),
                        types: vec![],
                        description: None,
                        degree: 0,
                        is_class: false,
                    });
                if predicate == RDF_TYPE {
                    classes
                        .entry(object.value.clone())
                        .or_default()
                        .insert(subject.clone());
                    resources.get_mut(&object.value).unwrap().is_class = true;
                    resources
                        .get_mut(&subject)
                        .unwrap()
                        .types
                        .push(object.value.clone());
                } else {
                    relationships += 1;
                    resources.get_mut(&subject).unwrap().degree += 1;
                    resources.get_mut(&object.value).unwrap().degree += 1;
                }
            } else {
                let rank = LABELS.iter().position(|p| *p == predicate).map(|p| {
                    p * 3
                        + match object.language.as_deref() {
                            Some("en") => 0,
                            None => 1,
                            _ => 2,
                        }
                });
                if let Some(rank) = rank {
                    let entry = labels
                        .entry(subject.clone())
                        .or_insert((usize::MAX, String::new()));
                    if (rank, &object.value) < (entry.0, &entry.1) {
                        *entry = (rank, object.value.clone());
                    }
                }
                if matches!(
                    short(&predicate).as_str(),
                    "description" | "comment" | "abstract"
                ) {
                    resources.get_mut(&subject).unwrap().description = Some(object.value.clone());
                }
            }
            if object.kind != "literal" && predicate != RDF_TYPE {
                *predicates.entry(predicate.clone()).or_default() += 1;
            }
            *graphs.entry(graph.clone()).or_default() += 1;
            statements.push(Statement {
                subject,
                predicate,
                object,
                graph,
            });
        }
        for (id, (_, label)) in labels {
            resources.get_mut(&id).unwrap().label = label;
        }
        for r in resources.values_mut() {
            r.types.sort();
            r.types.dedup();
        }
        let facets = |items: BTreeMap<String, usize>| {
            let mut values: Vec<_> = items
                .into_iter()
                .map(|(id, count)| Facet {
                    label: resources
                        .get(&id)
                        .map(|r| r.label.clone())
                        .unwrap_or_else(|| short(&id)),
                    id,
                    count,
                })
                .collect();
            values.sort_by(|a, b| b.count.cmp(&a.count).then(a.label.cmp(&b.label)));
            values
        };
        let summary = Summary {
            name,
            sampled: source == "endpoint",
            source,
            endpoint,
            triples: statements.len(),
            resources: resources.len(),
            relationships,
            classes: facets(
                classes
                    .into_iter()
                    .map(|(id, ids)| (id, ids.len()))
                    .collect(),
            ),
            predicates: facets(predicates),
            graphs: facets(graphs),
        };
        Ok(Self {
            store,
            summary,
            resources,
            statements,
            outgoing,
            incoming,
        })
    }

    pub fn search(&self, text: &str, class: &str, limit: usize) -> Vec<Resource> {
        let text = text.to_lowercase();
        let mut rows: Vec<_> = self
            .resources
            .values()
            .filter(|r| {
                (text.is_empty()
                    || r.label.to_lowercase().contains(&text)
                    || r.id.to_lowercase().contains(&text))
                    && (class.is_empty() || r.types.iter().any(|t| t == class))
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            a.is_class
                .cmp(&b.is_class)
                .then(b.degree.cmp(&a.degree))
                .then(a.label.cmp(&b.label))
        });
        rows.truncate(limit.min(200));
        rows
    }

    pub fn graph(&self, center: Option<&str>, limit: usize, predicate: Option<&str>) -> Graph {
        let limit = limit.clamp(1, 200);
        let mut ids = BTreeSet::new();
        let mut candidates = Vec::new();
        if let Some(center) = center {
            if self.resources.contains_key(center) {
                ids.insert(center.to_owned());
            }
            for i in self
                .outgoing
                .get(center)
                .into_iter()
                .flatten()
                .chain(self.incoming.get(center).into_iter().flatten())
            {
                let s = &self.statements[*i];
                if s.object.kind == "literal"
                    || s.predicate == RDF_TYPE
                    || predicate.is_some_and(|p| p != s.predicate)
                {
                    continue;
                }
                candidates.push(if s.subject == center {
                    s.object.value.clone()
                } else {
                    s.subject.clone()
                });
            }
            candidates.sort();
            candidates.dedup();
        } else {
            candidates = self
                .search("", "", 200)
                .into_iter()
                .filter(|r| !r.is_class)
                .map(|r| r.id)
                .collect();
        }
        let total = if center.is_some() {
            candidates.len() + ids.len()
        } else {
            self.resources.values().filter(|r| !r.is_class).count()
        };
        for id in candidates {
            if ids.len() >= limit {
                break;
            }
            ids.insert(id);
        }
        let mut edges = vec![];
        let mut edge_total = 0;
        for (i, s) in self.statements.iter().enumerate() {
            if s.object.kind != "literal"
                && s.predicate != RDF_TYPE
                && ids.contains(&s.subject)
                && ids.contains(&s.object.value)
                && predicate.is_none_or(|p| p == s.predicate)
            {
                edge_total += 1;
                if edges.len() < 2000 {
                    edges.push(Edge {
                        id: format!("e{i}"),
                        source: s.subject.clone(),
                        target: s.object.value.clone(),
                        label: short(&s.predicate),
                        predicate: s.predicate.clone(),
                        graph: s.graph.clone(),
                    });
                }
            }
        }
        Graph {
            truncated: total > ids.len() || edge_total > edges.len(),
            total,
            nodes: ids
                .iter()
                .filter_map(|id| self.resources.get(id).cloned())
                .collect(),
            edges,
        }
    }

    pub fn detail(&self, id: &str) -> Result<Detail> {
        let resource = self
            .resources
            .get(id)
            .cloned()
            .ok_or("Resource not found in the loaded data.")?;
        let outs = self.outgoing.get(id).map(Vec::as_slice).unwrap_or_default();
        let ins = self.incoming.get(id).map(Vec::as_slice).unwrap_or_default();
        Ok(Detail {
            resource,
            outgoing: outs
                .iter()
                .take(300)
                .map(|i| self.statements[*i].clone())
                .collect(),
            incoming: ins
                .iter()
                .take(300)
                .map(|i| self.statements[*i].clone())
                .collect(),
            outgoing_total: outs.len(),
            incoming_total: ins.len(),
        })
    }

    pub fn query(&self, query: &str) -> Result<serde_json::Value> {
        self.query_cancellable(query, CancellationToken::new())
    }

    pub fn query_cancellable(
        &self,
        query: &str,
        token: CancellationToken,
    ) -> Result<serde_json::Value> {
        let results = SparqlEvaluator::new()
            .with_cancellation_token(token)
            .parse_query(query)
            .map_err(|e| e.to_string())?
            .on_store(&self.store)
            .execute()
            .map_err(|e| e.to_string())?;
        match results {
            QueryResults::Boolean(value) => {
                Ok(serde_json::json!({"kind":"boolean", "value":value}))
            }
            QueryResults::Solutions(mut solutions) => {
                let columns: Vec<_> = solutions
                    .variables()
                    .iter()
                    .map(|v| v.as_str().to_owned())
                    .collect();
                let mut rows = vec![];
                for row in solutions.by_ref().take(1000) {
                    let row = row.map_err(|e| e.to_string())?;
                    rows.push(
                        row.iter()
                            .map(|(v, t)| (v.as_str().to_owned(), RdfTerm::from_term(t)))
                            .collect::<BTreeMap<_, _>>(),
                    );
                }
                let truncated = solutions
                    .next()
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .is_some();
                Ok(
                    serde_json::json!({"kind":"bindings", "columns":columns, "rows":rows, "truncated":truncated}),
                )
            }
            QueryResults::Graph(mut triples) => {
                let mut rows = vec![];
                for row in triples.by_ref().take(1000) {
                    let t = row.map_err(|e| e.to_string())?;
                    let subject = match t.subject {
                        oxigraph::model::NamedOrBlankNode::NamedNode(n) => n.as_str().to_owned(),
                        oxigraph::model::NamedOrBlankNode::BlankNode(n) => {
                            format!("_:{}", n.as_str())
                        }
                    };
                    rows.push(serde_json::json!({"subject":RdfTerm::resource(&subject), "predicate":RdfTerm::resource(t.predicate.as_str()), "object":RdfTerm::from_term(&t.object)}));
                }
                let truncated = triples
                    .next()
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .is_some();
                Ok(
                    serde_json::json!({"kind":"bindings", "columns":["subject","predicate","object"], "rows":rows, "truncated":truncated}),
                )
            }
        }
    }

    pub fn export(&self) -> Result<Vec<u8>> {
        self.store
            .dump_to_writer(RdfFormat::NQuads, Vec::new())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_dataset_semantics_and_queries_named_graphs() {
        let data = br#"@prefix ex: <https://example.org/> . ex:g { ex:a ex:name "Alice"@en; ex:age "42"^^<http://www.w3.org/2001/XMLSchema#integer>; ex:knows _:friend . _:friend ex:name "Bob" . }"#;
        let ds = Dataset::parse(data, "example.trig", "file").unwrap();
        assert_eq!(ds.summary.triples, 4);
        assert_eq!(ds.summary.graphs[0].id, "https://example.org/g");
        let detail = ds.detail("https://example.org/a").unwrap();
        assert!(
            detail
                .outgoing
                .iter()
                .any(|s| s.object.language.as_deref() == Some("en"))
        );
        assert!(
            detail.outgoing.iter().any(|s| s.object.datatype.as_deref()
                == Some("http://www.w3.org/2001/XMLSchema#integer"))
        );
        let result = ds.query("SELECT ?name WHERE { GRAPH ?g { ?s <https://example.org/name> ?name } } ORDER BY ?name").unwrap();
        assert_eq!(result["rows"].as_array().unwrap().len(), 2);
        let roundtrip = Dataset::parse(&ds.export().unwrap(), "export.nq", "file").unwrap();
        assert_eq!(roundtrip.summary.triples, 4);
    }
    #[test]
    fn bounds_graph_and_exposes_incoming_links() {
        let ds = Dataset::parse(
            include_bytes!("../examples/research-library.trig"),
            "sample.trig",
            "sample",
        )
        .unwrap();
        let graph = ds.graph(None, 5, None);
        assert_eq!(graph.nodes.len(), 5);
        assert!(graph.truncated);
        let detail = ds.detail("https://example.org/tim").unwrap();
        assert!(
            detail
                .incoming
                .iter()
                .any(|s| s.predicate == "https://schema.org/author")
        );
        assert_eq!(detail.resource.label, "Tim Berners-Lee");
        assert!(!ds.search("berners", "", 10).is_empty());
        assert!(ds.query("DELETE WHERE { ?s ?p ?o }").is_err());
    }
    #[test]
    fn malformed_import_fails_without_a_partial_dataset() {
        assert!(
            Dataset::parse(
                b"<https://x> <https://p> \"valid\" . this is broken",
                "bad.ttl",
                "file"
            )
            .is_err()
        );
        assert!(Dataset::parse(b"", "unknown.exe", "file").is_err());
    }

    #[test]
    fn reads_supported_formats_and_blank_node_ids() {
        for (name, bytes) in [
            (
                "a.ttl",
                "<https://ex/s> <https://ex/p> _:b . _:b <https://ex/p> \"hello\" .",
            ),
            (
                "a.nt",
                "<https://ex/s> <https://ex/p> _:b .\n_:b <https://ex/p> \"hello\" .",
            ),
            (
                "a.nq",
                "<https://ex/s> <https://ex/p> _:b <https://ex/g> .\n_:b <https://ex/p> \"hello\" <https://ex/g> .",
            ),
            (
                "a.rdf",
                r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="https://ex/"><rdf:Description rdf:about="https://ex/s"><ex:p rdf:nodeID="b"/></rdf:Description><rdf:Description rdf:nodeID="b"><ex:p>hello</ex:p></rdf:Description></rdf:RDF>"#,
            ),
            (
                "a.jsonld",
                r#"[{"@id":"https://ex/s","https://ex/p":{"@id":"_:b"}},{"@id":"_:b","https://ex/p":{"@value":"hello"}}]"#,
            ),
        ] {
            let ds = Dataset::parse(bytes.as_bytes(), name, "file").unwrap();
            assert_eq!(ds.summary.triples, 2, "{name}");
            let blank = ds.resources.keys().find(|id| id.starts_with("_:")).unwrap();
            assert!(!blank.starts_with("_:_:"));
            assert_eq!(ds.detail(blank).unwrap().incoming_total, 1);
        }
    }

    #[test]
    fn query_limits_and_cancellation_are_enforced() {
        let data: String = (0..1010)
            .map(|i| format!("<https://ex/{i}> <https://ex/p> \"value\" .\n"))
            .collect();
        let ds = Dataset::parse(data.as_bytes(), "many.nt", "file").unwrap();
        let result = ds.query("SELECT * WHERE { ?s ?p ?o }").unwrap();
        assert_eq!(result["rows"].as_array().unwrap().len(), 1000);
        assert_eq!(result["truncated"], true);
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(
            ds.query_cancellable("SELECT * WHERE { ?s ?p ?o }", cancellation)
                .is_err()
        );
    }
}
