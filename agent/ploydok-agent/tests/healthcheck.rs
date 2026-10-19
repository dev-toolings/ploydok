// SPDX-License-Identifier: AGPL-3.0-only
//
// `ploydok-healthcheck` must accept a live listener and reject both a
// missing socket and a stale socket file left behind by a dead agent.

use std::os::unix::net::UnixListener;
use std::time::Duration;

use ploydok_agent::healthcheck::{probe, probe_target, ProbeTarget};
use tempfile::TempDir;

const TIMEOUT: Duration = Duration::from_secs(1);

#[test]
fn wildcard_tcp_listen_address_is_probed_on_loopback() {
    let target = probe_target(Some("0.0.0.0:50051"), Some("/ignored"), "/run/x.sock").unwrap();
    assert_eq!(target, ProbeTarget::Tcp("127.0.0.1:50051".parse().unwrap()));
}

#[test]
fn unix_probe_accepts_live_listener_and_rejects_stale_or_missing_socket() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("agent.sock");
    let target = ProbeTarget::Unix(path.clone());

    assert!(probe(&target, TIMEOUT).is_err(), "missing socket must fail");

    let listener = UnixListener::bind(&path).unwrap();
    probe(&target, TIMEOUT).expect("live listener must pass");

    drop(listener);
    assert!(
        path.exists(),
        "socket file stays behind after the listener dies"
    );
    assert!(probe(&target, TIMEOUT).is_err(), "stale socket must fail");
}
