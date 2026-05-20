//! Process entry point. Parses env vars, wires the in-memory store
//! into an `AppState`, builds the router, and serves over plain
//! HTTP — TLS is terminated at the Knative/ingress layer (ADR 0012).

use std::env;
use std::net::SocketAddr;
use std::sync::Arc;

use opfs_share_backend::{AppState, MemoryRendezvousStore, build_router};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

const DEFAULT_PORT: u16 = 8080;
const DEFAULT_HOST: &str = "0.0.0.0";

fn parse_allowed_origins(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,opfs_share_backend=debug")),
        )
        .init();

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let host = env::var("HOST").unwrap_or_else(|_| DEFAULT_HOST.to_owned());
    let allowed = parse_allowed_origins(env::var("ALLOWED_ORIGINS").ok());

    tracing::info!(?host, port, ?allowed, "starting opfs-share-backend");

    let store = Arc::new(MemoryRendezvousStore::new());
    let state = AppState::new(store, allowed);
    let app = build_router(state);

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = TcpListener::bind(addr).await?;
    tracing::info!(%addr, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Honour SIGINT (Ctrl-C) so Knative's container-stop signal drains
/// in-flight requests cleanly instead of getting hard-killed.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
