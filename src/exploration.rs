use crate::dataset::{Dataset, Detail, Edge, Graph, RDF_TYPE, Resource, Result, Statement, short};
use oxigraph::model::NamedNode;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

fn page_size() -> usize {
    25
}
#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Both,
    Outgoing,
    Incoming,
}
#[derive(Clone, Deserialize)]
pub struct PageRequest {
    pub id: String,
    #[serde(default)]
    pub direction: Direction,
    #[serde(default)]
    pub predicate: String,
    #[serde(default)]
    pub graph: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_size")]
    pub limit: usize,
}
impl PageRequest {
    pub fn validate(&self) -> Result<()> {
        if !self.id.starts_with("_:") {
            iri(&self.id)?;
        }
        if !self.predicate.is_empty() {
            iri(&self.predicate)?;
        }
        if !self.graph.is_empty() && self.graph != "default" {
            iri(&self.graph)?;
        }
        if self.limit == 0 || self.limit > 50 || self.offset > 1_000_000 {
            return Err("Use pages of 1–50 connections and an offset up to 1,000,000.".into());
        }
        Ok(())
    }
    pub fn matches(&self, s: &Statement) -> bool {
        s.object.kind != "literal"
            && s.predicate != RDF_TYPE
            && (self.predicate.is_empty() || s.predicate == self.predicate)
            && (self.graph.is_empty() || s.graph == self.graph)
            && ((self.direction != Direction::Incoming && s.subject == self.id)
                || (self.direction != Direction::Outgoing && s.object.value == self.id))
    }
}
pub fn iri(value: &str) -> Result<NamedNode> {
    NamedNode::new(value).map_err(|_| "Enter a complete, valid resource IRI.".into())
}
#[derive(Serialize)]
pub struct Page {
    pub graph: Graph,
    pub statements: Vec<Statement>,
    pub offset: usize,
    pub has_more: bool,
    pub next_offset: Option<usize>,
    pub total: Option<usize>,
    pub scope: &'static str,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
pub struct RelationGroup {
    pub predicate: String,
    pub label: String,
    pub direction: &'static str,
    pub count: usize,
}
#[derive(Serialize)]
pub struct Groups {
    pub groups: Vec<RelationGroup>,
    pub has_more: bool,
    pub scope: &'static str,
}
#[derive(Deserialize)]
pub struct SearchRequest {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub class: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_size")]
    pub limit: usize,
}
impl SearchRequest {
    pub fn validate(&self) -> Result<()> {
        if self.q.len() > 2000 || self.offset > 1_000_000 || self.limit == 0 || self.limit > 50 {
            return Err("Search is limited to 2,000 characters and pages of 1–50 results.".into());
        }
        if !self.class.is_empty() {
            iri(&self.class)?;
        }
        Ok(())
    }
}
#[derive(Serialize)]
pub struct SearchPage {
    pub items: Vec<Resource>,
    pub has_more: bool,
    pub next_offset: Option<usize>,
    pub scope: &'static str,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct Inspection {
    #[serde(flatten)]
    pub detail: Detail,
    pub properties_more: bool,
    pub scope: &'static str,
}

pub fn page_graph(ds: &Dataset, center: &str, statements: &[Statement]) -> Graph {
    let mut ids = BTreeSet::from([center.to_owned()]);
    let edges = statements
        .iter()
        .enumerate()
        .map(|(i, s)| {
            ids.insert(s.subject.clone());
            ids.insert(s.object.value.clone());
            Edge {
                id: format!("page-{i}"),
                source: s.subject.clone(),
                target: s.object.value.clone(),
                predicate: s.predicate.clone(),
                label: ds
                    .resources
                    .get(&s.predicate)
                    .map(|r| r.label.clone())
                    .unwrap_or_else(|| short(&s.predicate)),
                graph: s.graph.clone(),
            }
        })
        .collect();
    Graph {
        total: ids.len(),
        nodes: ids
            .iter()
            .filter_map(|id| ds.resources.get(id).cloned())
            .collect(),
        edges,
        truncated: false,
    }
}
impl Dataset {
    pub fn search_page(&self, p: &SearchRequest) -> Result<SearchPage> {
        p.validate()?;
        let matches = self.search(&p.q, &p.class, p.offset + p.limit + 1);
        let has_more = matches.len() > p.offset + p.limit;
        let items: Vec<_> = matches.into_iter().skip(p.offset).take(p.limit).collect();
        Ok(SearchPage {
            next_offset: has_more.then_some(p.offset + items.len()),
            items,
            has_more,
            scope: "local",
            warnings: vec![],
        })
    }

    pub fn inspect(&self, id: &str) -> Result<Inspection> {
        let mut detail = self.detail(id)?;
        let properties = self
            .statements
            .iter()
            .filter(|s| s.subject == id && (s.object.kind == "literal" || s.predicate == RDF_TYPE));
        detail.outgoing_total = properties.clone().count();
        detail.outgoing = properties.take(300).cloned().collect();
        Ok(Inspection {
            properties_more: detail.outgoing_total > detail.outgoing.len(),
            detail,
            scope: if self.summary.sampled {
                "cache"
            } else {
                "local"
            },
        })
    }

    pub fn connection_page(&self, p: &PageRequest) -> Result<Page> {
        p.validate()?;
        if !self.resources.contains_key(&p.id) {
            return Err("Resource not found in the loaded data.".into());
        }
        let mut rows: Vec<_> = self
            .statements
            .iter()
            .filter(|s| p.matches(s))
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            (
                &a.predicate,
                &a.subject,
                &a.object.kind,
                &a.object.value,
                &a.graph,
            )
                .cmp(&(
                    &b.predicate,
                    &b.subject,
                    &b.object.kind,
                    &b.object.value,
                    &b.graph,
                ))
        });
        let total = rows.len();
        let statements: Vec<_> = rows.into_iter().skip(p.offset).take(p.limit).collect();
        let next = p.offset + statements.len();
        let has_more = next < total;
        Ok(Page {
            graph: page_graph(self, &p.id, &statements),
            statements,
            offset: p.offset,
            has_more,
            next_offset: has_more.then_some(next),
            total: Some(total),
            scope: if self.summary.sampled {
                "cache"
            } else {
                "local"
            },
            warnings: vec![],
        })
    }
    pub fn relation_groups(&self, p: &PageRequest) -> Result<Groups> {
        p.validate()?;
        let mut groups = BTreeMap::new();
        for s in &self.statements {
            if s.object.kind == "literal"
                || s.predicate == RDF_TYPE
                || (!p.graph.is_empty() && s.graph != p.graph)
            {
                continue;
            }
            if s.subject == p.id {
                *groups.entry((s.predicate.clone(), "outgoing")).or_insert(0) += 1;
            }
            if s.object.value == p.id {
                *groups.entry((s.predicate.clone(), "incoming")).or_insert(0) += 1;
            }
        }
        let has_more = groups.len() > 200;
        Ok(Groups {
            groups: groups
                .into_iter()
                .take(200)
                .map(|((predicate, direction), count)| RelationGroup {
                    label: short(&predicate),
                    predicate,
                    direction,
                    count,
                })
                .collect(),
            has_more,
            scope: if self.summary.sampled {
                "cache"
            } else {
                "local"
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_pages_cover_matches_and_reject_invalid_requests() {
        let ds = Dataset::parse(
            b"@prefix e: <https://example/> . e:a e:p \"one\" . e:b e:p \"two\" . e:c e:p \"three\" .",
            "search.ttl",
            "file",
        )
        .unwrap();
        let mut request = SearchRequest {
            q: String::new(),
            class: String::new(),
            offset: 0,
            limit: 2,
        };
        let mut seen = BTreeSet::new();
        loop {
            let page = ds.search_page(&request).unwrap();
            assert!(page.items.len() <= 2);
            assert_eq!(page.has_more, page.next_offset.is_some());
            for item in page.items {
                assert!(seen.insert(item.id));
            }
            match page.next_offset {
                Some(offset) => request.offset = offset,
                None => break,
            }
        }
        assert_eq!(seen, ds.resources.keys().cloned().collect());
        request.offset = 100;
        let page = ds.search_page(&request).unwrap();
        assert!(page.items.is_empty());
        assert!(!page.has_more);
        request.limit = 0;
        assert!(ds.search_page(&request).is_err());
        request.limit = 2;
        request.class = "not an IRI".into();
        assert!(ds.search_page(&request).is_err());
    }

    #[test]
    fn inspection_preserves_terms_and_bounds_properties_in_both_scopes() {
        let mut rdf = String::from(
            "@prefix e: <https://example/> . e:g { e:s a e:Thing; e:name \"Name\"@en; e:knows e:other . e:other e:knows e:s . }",
        );
        let mut ds = Dataset::parse(rdf.as_bytes(), "inspect.trig", "file").unwrap();
        let inspection = ds.inspect("https://example/s").unwrap();
        assert_eq!(inspection.detail.outgoing_total, 2);
        assert_eq!(inspection.detail.incoming_total, 1);
        assert!(!inspection.properties_more);
        // The flattened wire contract must remain compatible with both UIs.
        let json = serde_json::to_value(inspection).unwrap();
        assert_eq!(json["resource"]["id"], "https://example/s");
        assert_eq!(json["scope"], "local");
        assert!(
            json["outgoing"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| { s["object"]["language"] == "en" && s["graph"] == "https://example/g" })
        );

        for n in 0..301 {
            rdf.push_str(&format!("e:s e:value \"{n}\" ."));
        }
        ds = Dataset::parse(rdf.as_bytes(), "inspect.trig", "file").unwrap();
        ds.summary.sampled = true;
        let inspection = ds.inspect("https://example/s").unwrap();
        assert_eq!(inspection.detail.outgoing.len(), 300);
        assert_eq!(inspection.detail.outgoing_total, 303);
        assert!(inspection.properties_more);
        assert_eq!(inspection.scope, "cache");
        assert!(ds.inspect("https://example/missing").is_err());
    }

    #[test]
    fn pages_cover_large_neighborhood_and_preserve_quad_identity() {
        let mut rdf = String::from("@prefix e: <https://example/> . e:s e:label \"literal\" .\n");
        for n in 0..137 {
            rdf.push_str(&format!("e:g {{ e:s e:p e:n{n:03} . }}\n"));
        }
        rdf.push_str("e:h { e:s e:p e:n000 . } e:other e:back e:s .");
        let ds = Dataset::parse(rdf.as_bytes(), "test.trig", "file").unwrap();
        let mut p = PageRequest {
            id: "https://example/s".into(),
            direction: Direction::Outgoing,
            predicate: String::new(),
            graph: String::new(),
            offset: 0,
            limit: 25,
        };
        let mut seen = BTreeSet::new();
        loop {
            let page = ds.connection_page(&p).unwrap();
            assert_eq!(page.total, Some(138));
            for s in &page.statements {
                assert!(seen.insert((s.object.value.clone(), s.graph.clone())));
            }
            match page.next_offset {
                Some(offset) => p.offset = offset,
                None => break,
            }
        }
        assert_eq!(seen.len(), 138);
        p.offset = 0;
        p.direction = Direction::Incoming;
        assert_eq!(ds.connection_page(&p).unwrap().statements.len(), 1);
        p.direction = Direction::Outgoing;
        p.graph = "https://example/h".into();
        assert_eq!(ds.connection_page(&p).unwrap().statements.len(), 1);
    }
}
