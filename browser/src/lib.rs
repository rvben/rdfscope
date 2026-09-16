use rdfscope::{Dataset, exploration, sample_dataset as sample};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;

#[wasm_bindgen]
pub struct BrowserSession {
    dataset: Dataset,
}

#[wasm_bindgen]
pub fn query_snapshot(nquads: &[u8], query: &str) -> Result<String, JsValue> {
    let run = || -> Result<String, String> {
        if query.len() > 100_000 {
            return Err("Query is too large (100 KB maximum).".into());
        }
        let ds = Dataset::parse(nquads, "snapshot.nq", "file")?;
        serde_json::to_string(&ds.query(query)?).map_err(|e| e.to_string())
    };
    run().map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
impl BrowserSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<BrowserSession, JsValue> {
        Ok(Self {
            dataset: sample().map_err(|e| JsValue::from_str(&e))?,
        })
    }

    pub fn import_file(&mut self, bytes: &[u8], filename: &str) -> Result<String, JsValue> {
        self.load(bytes, filename)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn request(&mut self, route: &str, payload: &str) -> Result<String, JsValue> {
        self.dispatch(route, payload)
            .map_err(|e| JsValue::from_str(&e))
    }
}

impl BrowserSession {
    fn load(&mut self, bytes: &[u8], filename: &str) -> Result<String, String> {
        if bytes.len() > MAX_FILE_BYTES {
            return Err(
                "Browser files are limited to 10 MB. Use the installed app for larger datasets."
                    .into(),
            );
        }
        let ds = Dataset::parse(bytes, filename, "file")?;
        let response = serde_json::to_string(&ds.summary).map_err(|e| e.to_string())?;
        self.dataset = ds;
        Ok(response)
    }

    fn dispatch(&mut self, route: &str, payload: &str) -> Result<String, String> {
        let p: Value = serde_json::from_str(payload).map_err(|e| e.to_string())?;
        let ds = &self.dataset;
        let string = |key: &str| p[key].as_str().unwrap_or_default();
        let value = match route {
            "/summary" => json!(ds.summary),
            "/resources" => json!(ds.search(string("q"), string("class"), 200)),
            "/graph" => json!(ds.graph(p["center"].as_str(), p["limit"].as_u64().unwrap_or(35) as usize, p["predicate"].as_str())),
            "/resource" => json!(ds.detail(string("id"))?),
            "/expand" => json!(ds.graph(Some(string("id")), 60, None)),
            "/neighborhood" => {
                let request: exploration::PageRequest = serde_json::from_value(p).map_err(|e| e.to_string())?;
                json!(ds.connection_page(&request)?)
            }
            "/relations" => {
                let request: exploration::PageRequest = serde_json::from_value(p).map_err(|e| e.to_string())?;
                json!(ds.relation_groups(&request)?)
            }
            "/search" => {
                let request: exploration::SearchRequest = serde_json::from_value(p).map_err(|e| e.to_string())?;
                json!(ds.search_page(&request)?)
            }
            "/inspect" => json!(ds.inspect(string("id"))?),
            "/query" => {
                let query = string("query");
                if query.len() > 100_000 { return Err("Query is too large (100 KB maximum).".into()); }
                ds.query(query)?
            }
            "/export" => return String::from_utf8(ds.export()?).map_err(|e| e.to_string()),
            "/sample" => { self.dataset = sample()?; json!(self.dataset.summary) }
            "/trace" => json!([]),
            "/trace/clear" => json!({"ok": true}),
            "/connect" => return Err("Endpoint connections are available in the installed app. This browser edition explores local files.".into()),
            _ => return Err("Unknown browser operation.".into()),
        };
        serde_json::to_string(&value).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_session_preserves_rdf_and_failed_imports() {
        let mut session = BrowserSession {
            dataset: sample().unwrap(),
        };
        session.load(b"<https://ex/g> { <https://ex/a> <https://ex/p> <https://ex/b> ; <https://ex/name> \"Name\"@en . }", "test.trig").unwrap();
        let detail: Value = serde_json::from_str(
            &session
                .dispatch("/inspect", r#"{"id":"https://ex/a"}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(detail["outgoing"][0]["object"]["language"], "en");
        assert_eq!(detail["outgoing"][0]["graph"], "https://ex/g");
        assert!(session.load(b"bad turtle", "bad.ttl").is_err());
        assert_eq!(session.dataset.summary.triples, 2);
        let query: Value = serde_json::from_str(
            &session
                .dispatch("/query", r#"{"query":"ASK { GRAPH ?g { ?s ?p ?o } }"}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(query["value"], true);
        let exported = session.dispatch("/export", "{}").unwrap();
        session.load(exported.as_bytes(), "roundtrip.nq").unwrap();
        assert_eq!(session.dataset.summary.triples, 2);
    }
}
