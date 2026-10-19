// SPDX-License-Identifier: AGPL-3.0-only
//
// Container healthcheck probe, shipped as the `ploydok-healthcheck` binary.
// A separate binary, not an agent subcommand: an older agent binary given an
// unknown argument would boot a second server and replace the live socket.
//
// Connects to the listener the agent would bind from the same environment
// (PLOYDOK_AGENT_ADDR, else PLOYDOK_AGENT_SOCKET). The listener is bound only
// after Docker, the validator, the audit signer and the PKI are ready, so an
// accepted connection means the boot sequence completed. A stale socket file
// left by a dead agent refuses the connection, unlike `test -S`.
//
// It does not issue an RPC: under mTLS the client credentials stay on the
// host by design. The full gRPC round trip is the API readiness check
// (`/health/ready`).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeTarget {
    Tcp(SocketAddr),
    Unix(PathBuf),
}

/// Resolves the probe target the way `main` resolves its listener. A wildcard
/// listen address is probed on the matching loopback.
pub fn probe_target(
    agent_addr: Option<&str>,
    agent_socket: Option<&str>,
    default_socket: &str,
) -> Result<ProbeTarget> {
    if let Some(addr) = agent_addr {
        let mut addr: SocketAddr = addr
            .parse()
            .with_context(|| format!("PLOYDOK_AGENT_ADDR invalide : {addr}"))?;
        if addr.ip().is_unspecified() {
            addr.set_ip(match addr.ip() {
                IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
                IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
            });
        }
        return Ok(ProbeTarget::Tcp(addr));
    }
    Ok(ProbeTarget::Unix(PathBuf::from(
        agent_socket.unwrap_or(default_socket),
    )))
}

pub fn probe(target: &ProbeTarget, timeout: Duration) -> Result<()> {
    match target {
        ProbeTarget::Tcp(addr) => {
            TcpStream::connect_timeout(addr, timeout)
                .with_context(|| format!("agent injoignable sur {addr}"))?;
        }
        ProbeTarget::Unix(path) => {
            UnixStream::connect(path)
                .with_context(|| format!("agent injoignable sur {}", path.display()))?;
        }
    }
    Ok(())
}

/// Same default as the agent listener in `main.rs`.
const DEFAULT_SOCKET: &str = "/run/ploydok/agent.sock";

pub fn run() -> Result<()> {
    let addr = std::env::var("PLOYDOK_AGENT_ADDR").ok();
    let socket = std::env::var("PLOYDOK_AGENT_SOCKET").ok();
    let target = probe_target(addr.as_deref(), socket.as_deref(), DEFAULT_SOCKET)?;
    probe(&target, Duration::from_secs(2))
}
