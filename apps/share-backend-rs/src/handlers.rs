//! One handler per route. Each is `async fn (State, …) ->
//! Result<Response, AppError>` so we can drive them through
//! `Router::oneshot` in tests without binding a real socket.

use std::cmp::max;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use opfs_crypto::commitment::{CODE_LEN, code_for_pubkey};

use crate::config::{MAX_BLOB_BYTES, MINT_RATE_LIMIT, RENDEZVOUS_TTL_SECONDS};
use crate::errors::AppError;
use crate::state::AppState;
use crate::store::RendezvousRecord;

/// X25519 public-key length in bytes (mirrors `opfs_crypto::share`).
const X25519_PUBKEY_LEN: usize = 32;
const APP_OCTET_STREAM: &str = "application/octet-stream";

/// Resolve the client IP from the proxy-set headers.
///
/// `X-Forwarded-For` (Knative's ingress sets this) is preferred,
/// with `Forwarded` (RFC 7239) as a fallback, and a placeholder
/// when neither is present. Pure-string parse — no DNS, no
/// allocation in the common case.
pub fn client_ip(headers: &HeaderMap) -> String {
    if let Some(value) = headers.get("x-forwarded-for") {
        if let Ok(s) = value.to_str() {
            // First entry in the comma-separated list is the real
            // client; the rest are intermediate proxies (Knative,
            // ingress, …) that appended themselves.
            if let Some(first) = s.split(',').next() {
                let trimmed = first.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_owned();
                }
            }
        }
    }
    if let Some(value) = headers.get("forwarded") {
        if let Ok(s) = value.to_str() {
            // RFC 7239: look for `for="…";` token.
            for token in s.split(';') {
                let token = token.trim();
                if let Some(rest) = token.strip_prefix("for=") {
                    let rest = rest.trim_matches(|c| c == '"');
                    if !rest.is_empty() {
                        return rest.to_owned();
                    }
                }
            }
        }
    }
    "0.0.0.0".to_owned()
}

/// Clamp a derived TTL to at least one second so callers never hand
/// a zero-or-negative TTL into the store. The store would otherwise
/// be free to evict the record on the spot.
fn remaining_ttl(expires_at: u64, now: u64) -> u64 {
    max(1, expires_at.saturating_sub(now))
}

fn read_capped_body(body: Bytes, max: usize) -> Result<Bytes, AppError> {
    if body.len() > max {
        return Err(AppError::PayloadTooLarge(format!(
            "body exceeds {max} bytes"
        )));
    }
    Ok(body)
}

fn assert_code(code: &str) -> Result<(), AppError> {
    if code.len() != CODE_LEN {
        return Err(AppError::BadRequest("malformed code".into()));
    }
    Ok(())
}

fn octet_stream_response(bytes: Vec<u8>) -> Response {
    let mut response = (StatusCode::OK, bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(APP_OCTET_STREAM),
    );
    response
}

/// `POST /rendezvous` — recipient mints a rendezvous. Body is the
/// raw 32-byte ephemeral X25519 pubkey. Returns `{code, expiresAt}`.
pub async fn mint_rendezvous(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let ip = client_ip(&headers);
    let minted = state
        .store
        .increment_mint_counter(&ip, RENDEZVOUS_TTL_SECONDS);
    if minted > MINT_RATE_LIMIT {
        return Err(AppError::RateLimited);
    }

    let body = read_capped_body(body, X25519_PUBKEY_LEN)?;
    if body.len() != X25519_PUBKEY_LEN {
        return Err(AppError::BadRequest(format!(
            "epk must be exactly {X25519_PUBKEY_LEN} bytes"
        )));
    }
    let epk_bytes = body.to_vec();
    let code = code_for_pubkey(&epk_bytes);
    let expires_at = (state.now)() + RENDEZVOUS_TTL_SECONDS;
    let ok = state.store.put_rendezvous(
        &code,
        RendezvousRecord {
            epk: epk_bytes,
            expires_at,
        },
        RENDEZVOUS_TTL_SECONDS,
    );
    if !ok {
        return Err(AppError::Conflict("code collision; retry".into()));
    }
    Ok(Json(serde_json::json!({
        "code": code,
        "expiresAt": expires_at,
    }))
    .into_response())
}

/// `GET /rendezvous/:code` — sender fetches the recipient's epk.
pub async fn fetch_rendezvous(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> Result<Response, AppError> {
    assert_code(&code)?;
    let record = state
        .store
        .get_rendezvous(&code)
        .ok_or_else(|| AppError::NotFound("no such rendezvous".into()))?;
    if record.expires_at <= (state.now)() {
        return Err(AppError::Gone("rendezvous expired".into()));
    }
    Ok(octet_stream_response(record.epk))
}

/// `POST /rendezvous/:code/blob` — sender uploads the encrypted blob.
pub async fn upload_blob(
    State(state): State<AppState>,
    Path(code): Path<String>,
    body: Bytes,
) -> Result<Response, AppError> {
    assert_code(&code)?;
    let record = state
        .store
        .get_rendezvous(&code)
        .ok_or_else(|| AppError::NotFound("no such rendezvous".into()))?;
    let now = (state.now)();
    if record.expires_at <= now {
        return Err(AppError::Gone("rendezvous expired".into()));
    }
    let blob = read_capped_body(body, MAX_BLOB_BYTES)?;
    if blob.is_empty() {
        return Err(AppError::BadRequest("empty blob".into()));
    }
    let ok = state
        .store
        .put_blob(&code, blob.to_vec(), remaining_ttl(record.expires_at, now));
    if !ok {
        return Err(AppError::Conflict("blob already uploaded".into()));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `GET /rendezvous/:code/blob` — recipient picks up the blob, once.
pub async fn download_blob(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> Result<Response, AppError> {
    assert_code(&code)?;
    let blob = state
        .store
        .take_blob(&code)
        .ok_or_else(|| AppError::NotFound("blob unavailable".into()))?;
    Ok(octet_stream_response(blob))
}
