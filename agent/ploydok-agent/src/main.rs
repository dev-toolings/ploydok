// SPDX-License-Identifier: AGPL-3.0-only
//
// ploydok-agent — entry point.
//
// Bootstraps tracing (JSON), connects to Docker, binds a Unix socket or TCP
// listener, and serves the gRPC AgentService with mTLS.
//
// Configuration (env vars):
//   PLOYDOK_AGENT_SOCKET      Path to the Unix socket
//                             (default: /run/ploydok/agent.sock)
//   PLOYDOK_AGENT_ADDR        TCP listen address for Docker-internal mTLS
//                             (example: 0.0.0.0:50051). If set, takes
//                             precedence over PLOYDOK_AGENT_SOCKET.
//   PLOYDOK_AGENT_PKI_DIR     PKI directory for mTLS certs
//                             (default: /var/lib/ploydok/pki)
//   PLOYDOK_AGENT_INSECURE    Set to "1" to disable mTLS (dev/CI only — DANGER)
//   PLOYDOK_VALIDATOR_CONFIG  Path to a TOML/JSON validator config file
//   DOCKER_HOST               Override Docker daemon endpoint

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::net::{TcpListener, UnixListener};
use tokio_stream::wrappers::{TcpListenerStream, UnixListenerStream};
use tonic::transport::Server;
use tracing::{info, warn};

use ploydok_proto::agent::agent_server::AgentServer;

mod audit;
mod audit_signer;
mod boot_guard;
mod buildkit_profile;
mod host_stats;
mod pki;
#[allow(clippy::result_large_err)]
mod service;
mod socket_config;
mod validator;

use audit_signer::AuditSigner;
use boot_guard::assert_insecure_safe_from_process_env;
use service::AgentService;
use socket_config::{validate_socket_path, ALLOWED_SOCKET_DIRS};
use validator::{StrictValidator, Validator};

const DEFAULT_SOCKET: &str = "/run/ploydok/agent.sock";
const DEFAULT_PKI_DIR: &str = "/var/lib/ploydok/pki";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ── Tracing (JSON) ───────────────────────────────────────────────────────
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // ── Listen target ────────────────────────────────────────────────────────
    let agent_addr = std::env::var("PLOYDOK_AGENT_ADDR").ok();
    let socket_path = if agent_addr.is_some() {
        None
    } else {
        let socket_path =
            std::env::var("PLOYDOK_AGENT_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET.to_string());
        let socket_path = PathBuf::from(socket_path);
        validate_socket_path(&socket_path, ALLOWED_SOCKET_DIRS)?;
        Some(socket_path)
    };

    // ── Docker client ────────────────────────────────────────────────────────
    let docker = bollard::Docker::connect_with_socket_defaults()?;
    docker.ping().await?;
    info!("connected to Docker daemon");
    buildkit_profile::spawn_reconcile_task(docker.clone());

    // ── Validator ────────────────────────────────────────────────────────────
    let validator = StrictValidator::from_env()?;
    info!(
        config = ?validator.config(),
        "StrictValidator actif"
    );
    let validator: Arc<dyn Validator> = Arc::new(validator);

    // ── Audit signer ─────────────────────────────────────────────────────────
    let audit_key_dir: PathBuf = std::env::var("PLOYDOK_AUDIT_KEY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            // In dev (non-root), default to $HOME/.ploydok-dev/keys
            // In prod (root), default to /var/lib/ploydok/keys
            let is_root = unsafe { libc::geteuid() == 0 };
            if is_root {
                PathBuf::from("/var/lib/ploydok/keys")
            } else {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
                PathBuf::from(home).join(".ploydok-dev/keys")
            }
        });

    let audit_signer = AuditSigner::bootstrap(&audit_key_dir)?;
    info!(key_dir = %audit_key_dir.display(), "audit signer bootstrapped");

    // ── mTLS ou mode insecure ─────────────────────────────────────────────────
    let insecure = std::env::var("PLOYDOK_AGENT_INSECURE")
        .map(|v| v == "1")
        .unwrap_or(false);

    // Refuse to boot insecure if the env advertises production. The check is
    // not a substitute for proper PKI hygiene but stops at least the obvious
    // accident of pushing `PLOYDOK_AGENT_INSECURE=1` to a prod compose file.
    assert_insecure_safe_from_process_env(insecure)?;

    let host_sampler = host_stats::HostSampler::new();
    Arc::clone(&host_sampler).spawn_poll_task();

    let make_svc = || {
        AgentServer::new(AgentService::new(
            docker.clone(),
            Arc::clone(&validator),
            Arc::clone(&audit_signer),
            Arc::clone(&host_sampler),
        ))
    };

    let tls = if insecure {
        warn!("⚠️  mTLS DÉSACTIVÉ (PLOYDOK_AGENT_INSECURE=1) — NE JAMAIS UTILISER EN PRODUCTION");
        None
    } else {
        let pki_dir =
            std::env::var("PLOYDOK_AGENT_PKI_DIR").unwrap_or_else(|_| DEFAULT_PKI_DIR.to_string());
        let pki = pki::ensure_pki(&pki_dir)?;
        Some(
            tonic::transport::ServerTlsConfig::new()
                .identity(tonic::transport::Identity::from_pem(
                    &pki.server_cert_pem,
                    &pki.server_key_pem,
                ))
                .client_ca_root(tonic::transport::Certificate::from_pem(&pki.ca_cert_pem)),
        )
    };

    if let Some(addr) = agent_addr {
        let listener = TcpListener::bind(&addr).await?;
        let stream = TcpListenerStream::new(listener);
        info!(addr = %addr, "ploydok-agent listening");

        let mut builder = Server::builder();
        if let Some(tls) = tls {
            builder
                .tls_config(tls)?
                .add_service(make_svc())
                .serve_with_incoming(stream)
                .await?;
        } else {
            builder
                .add_service(make_svc())
                .serve_with_incoming(stream)
                .await?;
        }
    } else if let Some(socket_path) = socket_path {
        let parent = socket_path
            .parent()
            .expect("validate_socket_path guarantees a parent");

        if !parent.exists() {
            std::fs::create_dir_all(parent)?;
            info!(path = %parent.display(), "created socket parent directory");
        }

        if socket_path.exists() {
            std::fs::remove_file(&socket_path)?;
            info!(path = %socket_path.display(), "removed stale socket file");
        }

        // Allow non-root host clients (e.g. the API running as the dev user) to
        // connect when the agent runs as root inside its container. We narrow
        // the umask so the socket is born with mode 0o666 — eliminating the
        // race window before a post-bind chmod.
        //
        // SAFETY: umask() is process-global and not thread-safe. We call it
        // during single-threaded boot before any file-creating task is spawned.
        let prev_umask = unsafe { libc::umask(0o111) };
        let listener = UnixListener::bind(&socket_path)?;
        unsafe {
            libc::umask(prev_umask);
        }
        if let Err(err) =
            std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o666))
        {
            warn!(?err, socket = %socket_path.display(),
                "failed to chmod 0o666 on socket; non-root host clients may fail to connect");
        }
        let stream = UnixListenerStream::new(listener);
        info!(socket = %socket_path.display(), "ploydok-agent listening");

        let mut builder = Server::builder();
        if let Some(tls) = tls {
            builder
                .tls_config(tls)?
                .add_service(make_svc())
                .serve_with_incoming(stream)
                .await?;
        } else {
            builder
                .add_service(make_svc())
                .serve_with_incoming(stream)
                .await?;
        }
    }

    Ok(())
}
