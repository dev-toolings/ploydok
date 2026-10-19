// SPDX-License-Identifier: AGPL-3.0-only
// The zero-replica Swarm service is a deployment descriptor, not a data plane.
// Standalone overlay endpoints use manager AttachNetwork and support live joins.
use super::bollard_err;
use bollard::container::{
    Config, CreateContainerOptions, InspectContainerOptions, ListContainersOptions,
    NetworkingConfig, RemoveContainerOptions,
};
use bollard::models::{
    EndpointSettings, HostConfig, PortBinding, RestartPolicy, RestartPolicyNameEnum, ServiceSpec,
};
use bollard::network::ListNetworksOptions;
use bollard::service::{InspectServiceOptions, UpdateServiceOptions};
use bollard::Docker;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};
use tonic::Status;

pub static LOCK: Mutex<()> = Mutex::const_new(());
pub const NAME: &str = "ploydok-caddy";
pub(super) const REVISION: &str = "ploydok.ingress.revision";

/// Translate the reviewed service descriptor without introducing a shared
/// workload network. Network membership is deliberately outside the revision.
pub fn runtime_config(spec: &ServiceSpec) -> Result<Config<String>, Status> {
    let task = spec
        .task_template
        .as_ref()
        .ok_or_else(|| Status::failed_precondition("ingress_task_spec_missing"))?;
    let c = task
        .container_spec
        .as_ref()
        .ok_or_else(|| Status::failed_precondition("ingress_container_spec_missing"))?;
    if c.secrets.as_ref().is_some_and(|v| !v.is_empty())
        || c.configs.as_ref().is_some_and(|v| !v.is_empty())
    {
        return Err(Status::failed_precondition(
            "ingress_requires_bind_mounted_config",
        ));
    }
    let image = c
        .image
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Status::failed_precondition("ingress_image_missing"))?;
    let mut ports = HashMap::new();
    for port in spec
        .endpoint_spec
        .as_ref()
        .and_then(|s| s.ports.as_ref())
        .into_iter()
        .flatten()
    {
        if port.publish_mode.map(|m| m.to_string()).as_deref() != Some("host") {
            return Err(Status::failed_precondition("ingress_requires_host_ports"));
        }
        let target = port
            .target_port
            .ok_or_else(|| Status::failed_precondition("ingress_target_port_missing"))?;
        let published = port
            .published_port
            .ok_or_else(|| Status::failed_precondition("ingress_published_port_missing"))?;
        ports.insert(
            format!(
                "{target}/{}",
                port.protocol
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "tcp".into())
            ),
            Some(vec![PortBinding {
                // Leave the binding address unset, as in the service descriptor,
                // so Docker retains its IPv4/IPv6 wildcard publishing behavior.
                host_ip: None,
                host_port: Some(published.to_string()),
            }]),
        );
    }
    let limits = task.resources.as_ref().and_then(|r| r.limits.as_ref());
    let mut config = Config {
        image: Some(image),
        env: c.env.clone(),
        user: c.user.clone(),
        working_dir: c.dir.clone(),
        entrypoint: c.command.clone(),
        cmd: if c.command.is_none() && c.args.is_none() {
            Some(
                [
                    "caddy",
                    "run",
                    "--config",
                    "/etc/caddy/Caddyfile",
                    "--adapter",
                    "caddyfile",
                    "--resume",
                ]
                .map(String::from)
                .to_vec(),
            )
        } else {
            c.args.clone()
        },
        healthcheck: c.health_check.clone(),
        stop_signal: c.stop_signal.clone(),
        host_config: Some(HostConfig {
            mounts: c.mounts.clone(),
            port_bindings: Some(ports),
            restart_policy: Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            readonly_rootfs: c.read_only,
            cap_add: c.capability_add.clone(),
            cap_drop: c.capability_drop.clone(),
            group_add: c.groups.clone(),
            init: c.init,
            sysctls: c.sysctls.clone(),
            nano_cpus: limits.and_then(|r| r.nano_cpus),
            memory: limits.and_then(|r| r.memory_bytes),
            pids_limit: limits.and_then(|r| r.pids),
            ..Default::default()
        }),
        labels: Some(c.labels.clone().unwrap_or_default()),
        ..Default::default()
    };
    let stable = serde_json::to_value(&config).map_err(|e| Status::internal(e.to_string()))?;
    let revision = hex::encode(Sha256::digest(stable.to_string()));
    let labels = config.labels.get_or_insert_with(HashMap::new);
    labels.remove("com.docker.stack.namespace");
    labels.insert("ploydok.kind".into(), "infra".into());
    labels.insert("ploydok.component".into(), "caddy".into());
    labels.insert(REVISION.into(), revision);
    Ok(config)
}

pub async fn reconcile_locked(docker: &Docker) -> Result<Option<String>, Status> {
    let current = match docker
        .inspect_service(
            "ploydok_caddy",
            Some(InspectServiceOptions {
                insert_defaults: false,
            }),
        )
        .await
    {
        Ok(service) => service,
        Err(bollard::errors::Error::DockerResponseServerError {
            status_code: 404 | 503,
            ..
        }) => return Ok(None),
        Err(e) => return Err(bollard_err("inspect_ingress_descriptor", e)),
    };
    let mut spec = current
        .spec
        .ok_or_else(|| Status::failed_precondition("ingress_descriptor_missing"))?;
    if spec.name.as_deref() != Some("ploydok_caddy")
        || spec
            .labels
            .as_ref()
            .and_then(|l| l.get("ploydok.component"))
            .map(String::as_str)
            != Some("caddy")
    {
        return Err(Status::permission_denied(
            "ingress_descriptor_identity_mismatch",
        ));
    }
    let mut config = runtime_config(&spec)?;
    let existing = match docker
        .inspect_container(NAME, None::<InspectContainerOptions>)
        .await
    {
        Ok(c) => Some(c),
        Err(bollard::errors::Error::DockerResponseServerError {
            status_code: 404, ..
        }) => None,
        Err(e) => return Err(bollard_err("inspect_ingress_runtime", e)),
    };
    if let Some(c) = &existing {
        if c.config
            .as_ref()
            .and_then(|c| c.labels.as_ref())
            .and_then(|l| l.get("ploydok.component"))
            .map(String::as_str)
            != Some("caddy")
        {
            return Err(Status::permission_denied("ingress_runtime_name_in_use"));
        }
    }
    // Preflight before shutting down any ingress. The installer/upgrader pulls
    // digest-pinned images with its root registry credentials.
    docker
        .inspect_image(
            config
                .image
                .as_deref()
                .ok_or_else(|| Status::failed_precondition("ingress_image_missing"))?,
        )
        .await
        .map_err(|e| bollard_err("inspect_ingress_image", e))?;
    // All project overlays are attached before --resume reloads dynamic routes.
    // Only Caddy joins them; no project gains access to another project's plane.
    let networks = docker
        .list_networks(None::<ListNetworksOptions<String>>)
        .await
        .map_err(|e| bollard_err("list_ingress_networks", e))?;
    let mut endpoints = HashMap::new();
    for network in &networks {
        let Some(name) = network.name.as_ref() else {
            continue;
        };
        let from_descriptor = spec
            .task_template
            .as_ref()
            .and_then(|t| t.networks.as_ref())
            .is_some_and(|ns| {
                ns.iter()
                    .any(|n| n.target == network.id || n.target == network.name)
            });
        let from_existing = existing
            .as_ref()
            .and_then(|c| c.network_settings.as_ref())
            .and_then(|n| n.networks.as_ref())
            .is_some_and(|n| n.contains_key(name));
        if from_descriptor
            || from_existing
            || (network.attachable == Some(true)
                && (name.starts_with("ploydok-swarm-proj-") || name.starts_with("ploydok-proj-")))
        {
            if network.driver.as_deref() == Some("overlay") && network.attachable != Some(true) {
                return Err(Status::failed_precondition(format!(
                    "ingress_network_not_attachable:{name}"
                )));
            }
            endpoints.insert(name.clone(), EndpointSettings::default());
        }
    }
    if endpoints.is_empty() {
        return Err(Status::failed_precondition("ingress_base_networks_missing"));
    }
    config.networking_config = Some(NetworkingConfig {
        endpoints_config: endpoints,
    });
    let replicated = spec
        .mode
        .as_mut()
        .and_then(|m| m.replicated.as_mut())
        .ok_or_else(|| Status::failed_precondition("ingress_requires_replicated_descriptor"))?;
    if replicated.replicas != Some(0) {
        replicated.replicas = Some(0);
        docker
            .update_service(
                "ploydok_caddy",
                spec.clone(),
                UpdateServiceOptions {
                    version: current.version.and_then(|v| v.index).ok_or_else(|| {
                        Status::failed_precondition("ingress_descriptor_version_missing")
                    })?,
                    registry_auth_from: true,
                    rollback: false,
                },
                None,
            )
            .await
            .map_err(|e| bollard_err("scale_ingress_descriptor", e))?;
    }
    // The manager owns task shutdown; never disconnect or stop a managed task.
    timeout(Duration::from_secs(30), async {
        loop {
            let tasks = docker
                .list_containers(Some(ListContainersOptions::<String> {
                    filters: HashMap::from([(
                        "label".into(),
                        vec!["com.docker.swarm.service.name=ploydok_caddy".into()],
                    )]),
                    ..Default::default()
                }))
                .await
                .map_err(|e| bollard_err("list_legacy_ingress", e))?;
            if tasks.is_empty() {
                return Ok::<_, Status>(());
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .map_err(|_| Status::failed_precondition("legacy_ingress_shutdown_pending"))??;
    let revision = config.labels.as_ref().and_then(|l| l.get(REVISION));
    if let Some(c) = &existing {
        let labels = c.config.as_ref().and_then(|c| c.labels.as_ref());
        if labels.and_then(|l| l.get(REVISION)) == revision {
            let id =
                c.id.clone()
                    .ok_or_else(|| Status::failed_precondition("ingress_runtime_id_missing"))?;
            if c.state.as_ref().and_then(|s| s.running) != Some(true) {
                docker
                    .start_container::<String>(&id, None)
                    .await
                    .map_err(|e| bollard_err("start_ingress_runtime", e))?;
            }
            return Ok(Some(id));
        }
    }
    if existing.is_some() {
        docker
            .remove_container(
                NAME,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| bollard_err("replace_ingress_runtime", e))?;
    }
    let created = docker
        .create_container(
            Some(CreateContainerOptions {
                name: NAME,
                platform: None,
            }),
            config,
        )
        .await
        .map_err(|e| bollard_err("create_ingress_runtime", e))?;
    docker
        .start_container::<String>(&created.id, None)
        .await
        .map_err(|e| bollard_err("start_ingress_runtime", e))?;
    Ok(Some(created.id))
}

pub fn spawn_reconcile_task(docker: Docker) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(10));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let _lock = LOCK.lock().await;
            if let Err(error) = reconcile_locked(&docker).await {
                tracing::warn!(%error, "standalone ingress reconciliation failed");
            }
        }
    });
}
