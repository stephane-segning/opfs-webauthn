//! CORS allow-list.
//!
//! The frontend (`opfs-web`) and this backend (`opfs-share-backend`)
//! deploy as two separate Knative Services on two different
//! Knative-assigned hostnames, so the browser issues cross-origin
//! POSTs that the allow-list must cover. `ALLOWED_ORIGINS` is the
//! only thing connecting the two — set it per cluster to the
//! frontend's Knative URL.
//!
//! Parsed once at startup from the env, re-checked per request —
//! no runtime mutation.

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;

use crate::state::AppState;

const ALLOWED_METHODS: &str = "GET, POST, OPTIONS";
const ALLOWED_HEADERS: &str = "content-type";
const PREFLIGHT_MAX_AGE: &str = "86400";

pub fn origin_is_allowed(origin: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|a| a == origin)
}

/// Tower-style middleware. Runs ahead of every route — including
/// OPTIONS preflight — so the allow-list is honored on simple
/// cross-origin POSTs (which skip preflight).
pub async fn cors_layer(
    State(state): State<AppState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    // Preflight: short-circuit. 204 with CORS headers on allowed
    // origins, 403 otherwise.
    if request.method() == Method::OPTIONS {
        return preflight_response(origin.as_deref(), &state.allowed_origins);
    }

    // Simple cross-origin POSTs bypass preflight, so enforce the
    // allow-list before any handler runs.
    if let Some(ref o) = origin {
        if !origin_is_allowed(o, &state.allowed_origins) {
            return forbidden_origin();
        }
    }

    let mut response = next.run(request).await;
    // Once we reach this point the origin has already passed the
    // pre-handler gate above, so the second `origin_is_allowed`
    // call gemini flagged would be redundant. Just apply the
    // headers when the origin is present.
    if let Some(o) = origin {
        apply_cors_headers(response.headers_mut(), &o);
    }
    response
}

fn preflight_response(origin: Option<&str>, allowed: &[String]) -> Response {
    let ok = origin.is_some_and(|o| origin_is_allowed(o, allowed));
    let status = if ok {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::FORBIDDEN
    };
    let mut response = Response::builder()
        .status(status)
        .body(axum::body::Body::empty())
        .expect("static body");
    if ok {
        // `ok` implies `origin.is_some_and(...)`, so the unwrap is
        // proven by the branch condition.
        apply_cors_headers(response.headers_mut(), origin.expect("ok ⇒ Some"));
    }
    response
}

fn forbidden_origin() -> Response {
    let body = serde_json::json!({ "error": "origin not allowed" });
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .expect("static body")
}

fn apply_cors_headers(headers: &mut HeaderMap, origin: &str) {
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(header::VARY, HeaderValue::from_static("origin"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(ALLOWED_METHODS),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(ALLOWED_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static(PREFLIGHT_MAX_AGE),
    );
}
