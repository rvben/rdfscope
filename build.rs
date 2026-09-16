fn main() {
    println!("cargo:rerun-if-changed=web/dist");
    assert!(
        std::path::Path::new("web/dist/index.html").is_file(),
        "The embedded interface is missing. From a Git checkout, run `make frontend` first. \
         Published Cargo and Python source packages already include the interface."
    );
}
