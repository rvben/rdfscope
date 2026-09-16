use crate::dataset::{Dataset, RdfTerm, Result};
use oxigraph::{io::RdfFormat, model::*, sparql::SparqlEvaluator, store::Store};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

static BATCH: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct Remote {
    pub url: String,
    pub token: Option<String>,
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
        })
    }

    async fn request(&self, query: &str) -> Result<(String, Vec<u8>)> {
        // A read-only parser gate also prevents SPARQL Update requests to remote stores.
        let _ = SparqlEvaluator::new()
            .parse_query(query)
            .map_err(|e| e.to_string())?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("RDFscope/0.1")
            .build()
            .map_err(|e| e.to_string())?;
        let mut request = client
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
        let (_, bytes) = self.request(&query).await?;
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

    pub async fn query(&self, query: &str) -> Result<Value> {
        let (content_type, bytes) = self.request(query).await?;
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
mod tests {
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
