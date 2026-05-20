//! axum `Router` wiring.
//!
//! One route per handler; the CORS middleware wraps everything so
//! the allow-list is enforced even on simple cross-origin POSTs
//! that skip preflight (matches the TS worker behaviour the
//! page-side client already expects).

use axum::{
    Router, middleware,
    routing::{get, post},
};
use tower_http::limit::RequestBodyLimitLayer;

use crate::config::MAX_BLOB_BYTES;
use crate::cors::cors_layer;
use crate::handlers::{download_blob, fetch_rendezvous, mint_rendezvous, upload_blob};
use crate::state::AppState;

/// Build the application router.
///
/// Wires every route, layers the CORS middleware, and caps every
/// request body at the largest single payload we accept
/// (`MAX_BLOB_BYTES`). Per-route caps inside the handlers tighten
/// that further — e.g. `/rendezvous` only accepts 32 bytes.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/rendezvous", post(mint_rendezvous))
        .route("/rendezvous/:code", get(fetch_rendezvous))
        .route(
            "/rendezvous/:code/blob",
            post(upload_blob).get(download_blob),
        )
        .layer(RequestBodyLimitLayer::new(MAX_BLOB_BYTES))
        .layer(middleware::from_fn_with_state(state.clone(), cors_layer))
        .with_state(state)
}
