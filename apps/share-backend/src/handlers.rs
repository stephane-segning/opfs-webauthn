//! One handler per route. Each is `async fn (State, …) ->
//! Result<Response, AppError>` so we can drive them through
//! `Router::oneshot` in tests without binding a real socket.

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
/// Returned when `trusted_ip_header` isn't set or the header is
/// missing on the request. Every request that lands in this bucket
/// shares one rate-limit counter — explicit fail-closed.
const UNKNOWN_CLIENT_BUCKET: &str = "unknown";

/// Resolve the client IP from a proxy-set header that the operator
/// has explicitly named trusted (`TRUSTED_IP_HEADER`, lowercased and
/// stored on `AppState`).
///
/// We **only** consult that header — never `X-Forwarded-For`'s first
/// hop, which is client-controllable. Codex caught that the
/// previous XFF-first-hop reader let an attacker spoof `Origin`-IP
/// values and rotate around the per-IP mint cap; this contract
/// closes that hole by requiring the deployment to declare which
/// header it trusts (nginx-ingress: `x-real-ip`, Cloudflare:
/// `cf-connecting-ip`, etc.).
///
/// When the header isn't configured or isn't present on the
/// request, every caller falls into a single shared bucket. The
/// rate limit becomes global rather than per-IP — strictly tighter,
/// not looser, and the documented best-effort posture (ADR 0011)
/// still holds.
pub fn client_ip(headers: &HeaderMap, state: &AppState) -> String {
    let Some(header_name) = state.trusted_ip_header.as_deref() else {
        return UNKNOWN_CLIENT_BUCKET.to_owned();
    };
    headers
        .get(header_name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or_else(|| UNKNOWN_CLIENT_BUCKET.to_owned(), str::to_owned)
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
    let ip = client_ip(&headers, &state);
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
    // Blob expiry == the rendezvous expiry, clamped to "at least
    // one second from now" so a sub-second-late upload still lands
    // briefly. Beyond that the rendezvous itself is gone.
    let blob_expires_at = record.expires_at.max(now.saturating_add(1));
    let ok = state.store.put_blob(&code, blob.to_vec(), blob_expires_at);
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
    let now = (state.now)();
    let blob = state
        .store
        .take_blob(&code, now)
        .ok_or_else(|| AppError::NotFound("blob unavailable".into()))?;
    Ok(octet_stream_response(blob))
}
