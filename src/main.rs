mod remote;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Query, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use clap::Parser;
use rdfscope::{Dataset, dataset, exploration, sample_dataset as sample};
use remote::Remote;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

#[derive(Parser)]
#[command(
    name = "rdfscope",
    version,
    about = "Explore RDF locally. One binary, your browser, your data."
)]
struct Args {
    /// RDF file to open (.ttl, .trig, .nt, .nq, .rdf, .jsonld)
    file: Option<PathBuf>,
    /// Connect to a SPARQL endpoint instead of opening a file
    #[arg(long, conflicts_with = "file")]
    endpoint: Option<String>,
    /// Name of an environment variable containing an endpoint bearer token
    #[arg(long, requires = "endpoint")]
    token_env: Option<String>,
    /// Local HTTP port (0 chooses an available port)
    #[arg(long, default_value_t = 7878)]
    port: u16,
    /// Do not open the default browser
    #[arg(long)]
    no_open: bool,
}
#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;
struct Workspace {
    dataset: Arc<Dataset>,
    remote: Option<Remote>,
}
struct AppState {
    workspace: RwLock<Workspace>,
    mutation: Mutex<()>,
    queries: Arc<Semaphore>,
}
type App = Arc<AppState>;
struct ApiError(StatusCode, String);
impl From<String> for ApiError {
    fn from(e: String) -> Self {
        Self(StatusCode::BAD_REQUEST, e)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
type ApiResult<T> = std::result::Result<T, ApiError>;
fn snapshot(app: &App) -> Arc<Dataset> {
    app.workspace.read().unwrap().dataset.clone()
}
fn replace(app: &App, dataset: Dataset, remote: Option<Remote>) {
    *app.workspace.write().unwrap() = Workspace {
        dataset: Arc::new(dataset),
        remote,
    };
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let (dataset, remote) = if let Some(url) = args.endpoint {
        let token = args
            .token_env
            .map(std::env::var)
            .transpose()
            .map_err(|_| "The requested token environment variable is not set.")?;
        let remote = Remote::new(url, token)?;
        (remote.fetch(None, None).await?, Some(remote))
    } else if let Some(path) = args.file {
        if std::fs::metadata(&path)?.len() > 64 * 1024 * 1024 {
            return Err("File exceeds the 64 MB import limit.".into());
        }
        let bytes = std::fs::read(&path)?;
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("data.ttl");
        (Dataset::parse(&bytes, filename, "file")?, None)
    } else {
        (sample()?, None)
    };
    let app = Arc::new(AppState {
        workspace: RwLock::new(Workspace {
            dataset: Arc::new(dataset),
            remote,
        }),
        mutation: Mutex::new(()),
        queries: Arc::new(Semaphore::new(2)),
    });
    let listener =
        tokio::net::TcpListener::bind((IpAddr::V4(Ipv4Addr::LOCALHOST), args.port)).await?;
    let url = format!("http://{}", listener.local_addr()?);
    println!(
        "\n  RDFscope — RDF explorer\n  {url}\n\n  Data stays in this process. Press Ctrl+C to stop.\n"
    );
    if !args.no_open {
        let _ = webbrowser::open(&url);
    }
    axum::serve(listener, router(app))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn router(app: App) -> Router {
    Router::new()
        .route("/api/summary", get(summary))
        .route("/api/resources", get(resources))
        .route("/api/graph", get(graph))
        .route("/api/resource", get(detail))
        .route("/api/import", post(import))
        .route("/api/sample", post(load_sample))
        .route("/api/connect", post(connect))
        .route("/api/expand", post(expand))
        .route("/api/neighborhood", post(neighborhood))
        .route("/api/relations", post(relations))
        .route("/api/search", post(search))
        .route("/api/inspect", post(inspect))
        .route("/api/trace", get(trace))
        .route("/api/trace/clear", post(clear_trace))
        .route("/api/query", post(query))
        .route("/api/export", get(export))
        .fallback(get(asset))
        .layer(DefaultBodyLimit::max(65 * 1024 * 1024))
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(middleware::from_fn(local_guard))
        .with_state(app)
}
async fn local_guard(request: axum::extract::Request, next: Next) -> Response {
    let headers = request.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !matches!(
        host.split(':').next().unwrap_or(""),
        "127.0.0.1" | "localhost"
    ) {
        return (
            StatusCode::FORBIDDEN,
            "RDFscope only accepts localhost requests.",
        )
            .into_response();
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && origin != format!("http://{host}")
    {
        return (StatusCode::FORBIDDEN, "Cross-origin requests are disabled.").into_response();
    }
    if request.method() == axum::http::Method::POST
        && headers
            .get("x-rdfscope-request")
            .and_then(|v| v.to_str().ok())
            != Some("1")
    {
        return (StatusCode::FORBIDDEN, "Missing local request header.").into_response();
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn summary(State(app): State<App>) -> Json<dataset::Summary> {
    Json(snapshot(&app).summary.clone())
}
#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: String,
    #[serde(default)]
    class: String,
}
async fn resources(
    State(app): State<App>,
    Query(p): Query<SearchParams>,
) -> Json<Vec<dataset::Resource>> {
    Json(snapshot(&app).search(&p.q, &p.class, 200))
}
#[derive(Deserialize)]
struct GraphParams {
    center: Option<String>,
    limit: Option<usize>,
    predicate: Option<String>,
}
async fn graph(State(app): State<App>, Query(p): Query<GraphParams>) -> Json<dataset::Graph> {
    Json(snapshot(&app).graph(
        p.center.as_deref(),
        p.limit.unwrap_or(35),
        p.predicate.as_deref(),
    ))
}
#[derive(Deserialize)]
struct ResourceParams {
    id: String,
}
async fn detail(
    State(app): State<App>,
    Query(p): Query<ResourceParams>,
) -> ApiResult<Json<dataset::Detail>> {
    Ok(Json(snapshot(&app).detail(&p.id)?))
}
async fn import(
    State(app): State<App>,
    mut multipart: Multipart,
) -> ApiResult<Json<dataset::Summary>> {
    let _guard = app.mutation.lock().await;
    let field = multipart
        .next_field()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Choose an RDF file.".to_owned())?;
    let filename = field.file_name().unwrap_or("data.ttl").to_owned();
    let bytes = field.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("File exceeds the 64 MB import limit.".to_owned().into());
    }
    let ds = tokio::task::spawn_blocking(move || Dataset::parse(&bytes, &filename, "file"))
        .await
        .map_err(|e| e.to_string())??;
    let summary = ds.summary.clone();
    replace(&app, ds, None);
    Ok(Json(summary))
}
async fn load_sample(State(app): State<App>) -> ApiResult<Json<dataset::Summary>> {
    let _guard = app.mutation.lock().await;
    let ds = sample()?;
    let summary = ds.summary.clone();
    replace(&app, ds, None);
    Ok(Json(summary))
}
#[derive(Deserialize)]
struct Connection {
    url: String,
    token: Option<String>,
    seed: Option<String>,
}
async fn connect(
    State(app): State<App>,
    Json(p): Json<Connection>,
) -> ApiResult<Json<dataset::Summary>> {
    let _guard = app.mutation.lock().await;
    let remote = Remote::new(p.url, p.token)?;
    let ds = remote
        .fetch(p.seed.as_deref().filter(|s| !s.trim().is_empty()), None)
        .await?;
    let summary = ds.summary.clone();
    replace(&app, ds, Some(remote));
    Ok(Json(summary))
}
async fn expand(
    State(app): State<App>,
    Json(p): Json<ResourceParams>,
) -> ApiResult<Json<dataset::Graph>> {
    let _guard = app.mutation.lock().await;
    let remote = app.workspace.read().unwrap().remote.clone();
    if let Some(remote) = remote
        && !p.id.starts_with("_:")
    {
        let previous = snapshot(&app);
        let ds = remote.fetch(Some(&p.id), Some(&previous)).await?;
        replace(&app, ds, Some(remote));
    }
    Ok(Json(snapshot(&app).graph(Some(&p.id), 60, None)))
}
async fn neighborhood(
    State(app): State<App>,
    Json(p): Json<exploration::PageRequest>,
) -> ApiResult<Json<exploration::Page>> {
    let _guard = app.mutation.lock().await;
    let remote = app.workspace.read().unwrap().remote.clone();
    let previous = snapshot(&app);
    if let Some(remote) = remote
        && !p.id.starts_with("_:")
    {
        let (ds, page) = remote.neighborhood(&p, &previous).await?;
        replace(&app, ds, Some(remote));
        Ok(Json(page))
    } else {
        Ok(Json(previous.connection_page(&p)?))
    }
}
async fn relations(
    State(app): State<App>,
    Json(p): Json<exploration::PageRequest>,
) -> ApiResult<Json<exploration::Groups>> {
    let remote = app.workspace.read().unwrap().remote.clone();
    if let Some(remote) = remote
        && !p.id.starts_with("_:")
    {
        Ok(Json(remote.groups(&p).await?))
    } else {
        Ok(Json(snapshot(&app).relation_groups(&p)?))
    }
}
async fn search(
    State(app): State<App>,
    Json(p): Json<exploration::SearchRequest>,
) -> ApiResult<Json<exploration::SearchPage>> {
    p.validate()?;
    let remote = app.workspace.read().unwrap().remote.clone();
    if let Some(remote) = remote {
        Ok(Json(remote.search(&p).await?))
    } else {
        Ok(Json(snapshot(&app).search_page(&p)?))
    }
}
async fn inspect(
    State(app): State<App>,
    Json(p): Json<ResourceParams>,
) -> ApiResult<Json<exploration::Inspection>> {
    let _guard = app.mutation.lock().await;
    let remote = app.workspace.read().unwrap().remote.clone();
    let previous = snapshot(&app);
    if let Some(remote) = remote
        && !p.id.starts_with("_:")
    {
        let (ds, more) = remote.inspect(&p.id, &previous).await?;
        let mut detail = ds.inspect(&p.id)?;
        detail.properties_more |= more;
        detail.scope = "endpoint";
        replace(&app, ds, Some(remote));
        Ok(Json(detail))
    } else {
        Ok(Json(previous.inspect(&p.id)?))
    }
}
async fn trace(State(app): State<App>) -> Json<Vec<remote::QueryTrace>> {
    Json(
        app.workspace
            .read()
            .unwrap()
            .remote
            .as_ref()
            .map(Remote::traces)
            .unwrap_or_default(),
    )
}
async fn clear_trace(State(app): State<App>) -> Json<Value> {
    if let Some(remote) = &app.workspace.read().unwrap().remote {
        remote.clear_traces();
    }
    Json(json!({"ok":true}))
}
#[derive(Deserialize)]
struct QueryRequest {
    query: String,
}
async fn query(State(app): State<App>, Json(p): Json<QueryRequest>) -> ApiResult<Json<Value>> {
    if p.query.len() > 100_000 {
        return Err("Query is too large (100 KB maximum).".to_owned().into());
    }
    let permit = app.queries.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Two queries are already running. Wait for one to finish.".into(),
        )
    })?;
    let start = Instant::now();
    let remote = app.workspace.read().unwrap().remote.clone();
    let mut result = if let Some(remote) = remote {
        remote.query(&p.query).await?
    } else {
        let ds = snapshot(&app);
        let token = oxigraph::sparql::CancellationToken::new();
        let cancellation = token.clone();
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            ds.query_cancellable(&p.query, token)
        });
        tokio::time::timeout(Duration::from_secs(30), task)
            .await
            .map_err(|_| {
                cancellation.cancel();
                "Query stopped after 30 seconds. Try a more selective query.".to_owned()
            })?
            .map_err(|e| e.to_string())??
    };
    result["elapsed_ms"] = json!(start.elapsed().as_millis());
    Ok(Json(result))
}
async fn export(State(app): State<App>) -> ApiResult<Response> {
    let ds = snapshot(&app);
    let bytes = tokio::task::spawn_blocking(move || ds.export())
        .await
        .map_err(|e| e.to_string())??;
    Ok((
        [
            (header::CONTENT_TYPE, "application/n-quads"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"rdfscope-export.nq\"",
            ),
        ],
        bytes,
    )
        .into_response())
}
async fn asset(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let Some(file) = Assets::get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") {
        "application/javascript"
    } else if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    };
    ([(header::CONTENT_TYPE, mime)], file.data.into_owned()).into_response()
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    fn app() -> Router {
        router(Arc::new(AppState {
            workspace: RwLock::new(Workspace {
                dataset: Arc::new(sample().unwrap()),
                remote: None,
            }),
            mutation: Mutex::new(()),
            queries: Arc::new(Semaphore::new(2)),
        }))
    }
    #[tokio::test]
    async fn localhost_api_works_and_rejects_cross_origin_mutation() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/summary")
                    .header("host", "127.0.0.1:7878")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/sample")
                    .method("POST")
                    .header("host", "evil.example")
                    .header("x-rdfscope-request", "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/sample")
                    .method("POST")
                    .header("host", "127.0.0.1:7878")
                    .header("origin", "https://evil.example")
                    .header("x-rdfscope-request", "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
