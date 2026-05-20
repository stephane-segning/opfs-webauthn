//! End-to-end tests driven through `Router::oneshot` against a real
//! `MemoryRendezvousStore` + an injected clock. Mirrors the surface
//! the TS backend's vitest suite exercises, so this Rust port is at
//! behavioural parity with the previous Cloudflare Worker.

use std::sync::{Arc, Mutex};

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use opfs_crypto::commitment::code_for_pubkey;
use opfs_share_backend::{AppState, MemoryRendezvousStore, build_router};
use serde_json::Value;
use tower::ServiceExt;

const ALLOWED_ORIGIN: &str = "http://test.local";

fn make_state() -> (AppState, Arc<Mutex<u64>>) {
    let store = Arc::new(MemoryRendezvousStore::new());
    let clock_inner = Arc::new(Mutex::new(1_700_000_000_u64));
    let clock_for_closure = Arc::clone(&clock_inner);
    let now = Arc::new(move || *clock_for_closure.lock().expect("clock"));
    let state = AppState::with_clock(store, vec![ALLOWED_ORIGIN.to_owned()], now);
    (state, clock_inner)
}

fn advance_clock(clock: &Arc<Mutex<u64>>, seconds: u64) {
    *clock.lock().expect("clock") += seconds;
}

async fn send(
    state: AppState,
    method: Method,
    uri: &str,
    body: Vec<u8>,
) -> (StatusCode, axum::body::Bytes) {
    let router = build_router(state);
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::ORIGIN, ALLOWED_ORIGIN)
        .body(Body::from(body))
        .expect("request");
    let response = router.oneshot(request).await.expect("oneshot");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, bytes)
}

async fn mint(state: AppState, epk_fill: u8) -> (StatusCode, Value) {
    let (status, body) = send(state, Method::POST, "/rendezvous", vec![epk_fill; 32]).await;
    let json = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).expect("json")
    };
    (status, json)
}

#[tokio::test]
async fn round_trips_epk_and_blob() {
    let (state, _clock) = make_state();
    let epk = vec![7u8; 32];
    let expected = code_for_pubkey(&epk);

    let (status, json) = mint(state.clone(), 7).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["code"].as_str().unwrap(), expected);

    let code = json["code"].as_str().unwrap().to_owned();

    let (status, body) = send(
        state.clone(),
        Method::GET,
        &format!("/rendezvous/{code}"),
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), epk.as_slice());

    let blob = vec![1u8, 2, 3, 4, 5];
    let (status, _) = send(
        state.clone(),
        Method::POST,
        &format!("/rendezvous/{code}/blob"),
        blob.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, body) = send(
        state,
        Method::GET,
        &format!("/rendezvous/{code}/blob"),
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), blob.as_slice());
}

#[tokio::test]
async fn rejects_wrong_length_epk() {
    let (state, _clock) = make_state();
    let (status, _) = send(state, Method::POST, "/rendezvous", vec![0u8; 31]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn returns_404_for_unknown_code() {
    let (state, _clock) = make_state();
    let (status, _) = send(state, Method::GET, "/rendezvous/AAAAAAAAAAAA", vec![]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rejects_duplicate_blob_upload() {
    let (state, _clock) = make_state();
    let (_, json) = mint(state.clone(), 2).await;
    let code = json["code"].as_str().unwrap().to_owned();
    let url = format!("/rendezvous/{code}/blob");

    let (first, _) = send(state.clone(), Method::POST, &url, vec![9]).await;
    assert_eq!(first, StatusCode::NO_CONTENT);

    let (second, _) = send(state, Method::POST, &url, vec![9]).await;
    assert_eq!(second, StatusCode::CONFLICT);
}

#[tokio::test]
async fn single_pickup_blob_deleted_on_first_read() {
    let (state, _clock) = make_state();
    let (_, json) = mint(state.clone(), 3).await;
    let code = json["code"].as_str().unwrap().to_owned();
    let upload_url = format!("/rendezvous/{code}/blob");
    let download_url = upload_url.clone();

    send(state.clone(), Method::POST, &upload_url, vec![1, 2, 3]).await;

    let (first, body) = send(state.clone(), Method::GET, &download_url, vec![]).await;
    assert_eq!(first, StatusCode::OK);
    assert_eq!(body.as_ref(), &[1u8, 2, 3]);

    let (second, _) = send(state, Method::GET, &download_url, vec![]).await;
    assert_eq!(second, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn expired_rendezvous_returns_410_gone() {
    let (state, clock) = make_state();
    let (_, json) = mint(state.clone(), 4).await;
    let code = json["code"].as_str().unwrap().to_owned();
    advance_clock(&clock, 301);
    let (status, _) = send(state, Method::GET, &format!("/rendezvous/{code}"), vec![]).await;
    assert_eq!(status, StatusCode::GONE);
}

#[tokio::test]
async fn rate_limits_after_the_mint_cap() {
    let (state, _clock) = make_state();
    for fill in 10..20 {
        let (status, _) = mint(state.clone(), fill).await;
        assert_eq!(status, StatusCode::OK, "mint {fill} should succeed");
    }
    let (blocked, _) = mint(state, 200).await;
    assert_eq!(blocked, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn rejects_oversize_blob() {
    let (state, _clock) = make_state();
    let (_, json) = mint(state.clone(), 5).await;
    let code = json["code"].as_str().unwrap().to_owned();
    // 64 KiB + 1 byte → tripping the request-body limit layer.
    let oversize = vec![0u8; 64 * 1024 + 1];
    let (status, _) = send(
        state,
        Method::POST,
        &format!("/rendezvous/{code}/blob"),
        oversize,
    )
    .await;
    // axum's RequestBodyLimitLayer surfaces 413 itself before the
    // handler runs, so we don't have to encode the cap twice.
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn cors_preflight_allows_listed_origin() {
    let (state, _clock) = make_state();
    let router = build_router(state);
    let request = Request::builder()
        .method(Method::OPTIONS)
        .uri("/rendezvous")
        .header(header::ORIGIN, ALLOWED_ORIGIN)
        .body(Body::empty())
        .expect("request");
    let response = router.oneshot(request).await.expect("oneshot");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .and_then(|v| v.to_str().ok()),
        Some(ALLOWED_ORIGIN),
    );
}

#[tokio::test]
async fn cors_rejects_unlisted_origin_before_handlers_run() {
    let (state, _clock) = make_state();
    let router = build_router(state);
    let request = Request::builder()
        .method(Method::POST)
        .uri("/rendezvous")
        .header(header::ORIGIN, "https://evil.example")
        .body(Body::from(vec![0u8; 32]))
        .expect("request");
    let response = router.oneshot(request).await.expect("oneshot");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    // Body shape is `{"error": "origin not allowed"}` — the existing
    // share-client maps this to a typed `originDenied` ShareError.
    let body = response.into_body().collect().await.expect("body");
    let json: Value = serde_json::from_slice(&body.to_bytes()).expect("json");
    assert_eq!(json["error"], "origin not allowed");
}
