//! Shared RDF engine for the native application and browser adapter.
//!
//! Parsing, indexing, exploration, and SPARQL live here. HTTP, endpoint access,
//! file limits, worker lifetimes, and user interface assets belong to adapters.
//! Disable default features to use the engine without the native application;
//! enable `browser` when targeting WebAssembly in a browser.

pub mod dataset;
pub mod exploration;

pub use dataset::Dataset;

/// Load the illustrative dataset used by both editions.
pub fn sample_dataset() -> dataset::Result<Dataset> {
    let mut dataset = Dataset::parse(
        include_bytes!("../examples/research-library.trig"),
        "research-library.trig",
        "sample",
    )?;
    dataset.summary.name = "The connected library".into();
    Ok(dataset)
}
