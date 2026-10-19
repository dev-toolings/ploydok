// SPDX-License-Identifier: AGPL-3.0-only
// Swarm tasks must receive overlay addresses from the manager, never local IPAM.
use super::bollard_err;
use bollard::container::{InspectContainerOptions, ListContainersOptions};
use bollard::models::{Network, NetworkAttachmentConfig, Service, ServiceSpec};
use bollard::network::InspectNetworkOptions;
use bollard::service::{InspectServiceOptions, ListServicesOptions, UpdateServiceOptions};
use bollard::Docker;
use serde::Serialize;
use std::collections::HashMap;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};
use tonic::Status;

// Serialize read/modify/write and convergence across concurrent deploys/reconcile.
static ATTACHMENT_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AttachmentState {
    AddressCollision {
        network: String,
        address: String,
        conflicting_endpoint: String,
    },
    AttachmentPending {
        network: String,
    },
}

impl AttachmentState {
    fn status(&self) -> Status {
        Status::failed_precondition(
            serde_json::to_string(self).expect("attachment state serializes"),
        )
    }
}

fn address(value: &str) -> &str {
    value.split('/').next().unwrap_or(value)
}

/// Network inspect includes every local task endpoint. Ploydok supports a
/// single-node Swarm, enforced by SwarmEnsureSingleNode, including production.
pub fn collision(
    network: &Network,
    caddy_id: &str,
    services: &[Service],
) -> Option<AttachmentState> {
    let endpoints = network.containers.as_ref()?;
    let caddy_ip = address(endpoints.get(caddy_id)?.ipv4_address.as_deref()?);
    if caddy_ip.is_empty() {
        return None;
    }
    let conflict = endpoints
        .iter()
        .find_map(|(id, endpoint)| {
            (id != caddy_id && endpoint.ipv4_address.as_deref().map(address) == Some(caddy_ip))
                .then(|| id.clone())
        })
        .or_else(|| {
            services.iter().find_map(|service| {
                service
                    .endpoint
                    .as_ref()?
                    .virtual_ips
                    .as_ref()?
                    .iter()
                    .find_map(|vip| {
                        (vip.network_id == network.id
                            && vip.addr.as_deref().map(address) == Some(caddy_ip))
                        .then(|| format!("vip:{}", service.id.as_deref().unwrap_or("unknown")))
                    })
            })
        })?;
    Some(AttachmentState::AddressCollision {
        network: network.name.clone().unwrap_or_default(),
        address: caddy_ip.to_string(),
        conflicting_endpoint: conflict,
    })
}

pub fn set_network(spec: &mut ServiceSpec, network: &Network, attach: bool) -> bool {
    let networks = spec
        .task_template
        .get_or_insert_with(Default::default)
        .networks
        .get_or_insert_with(Vec::new);
    let matches = |entry: &NetworkAttachmentConfig| {
        entry.target.is_some() && (entry.target == network.id || entry.target == network.name)
    };
    if attach {
        if networks.iter().any(matches) {
            return false;
        }
        networks.push(NetworkAttachmentConfig {
            target: network.id.clone(),
            ..Default::default()
        });
    } else {
        let previous = networks.len();
        networks.retain(|entry| !matches(entry));
        return previous != networks.len();
    }
    true
}

async fn inspect_network(docker: &Docker, name: &str) -> Result<Network, Status> {
    docker
        .inspect_network(name, None::<InspectNetworkOptions<String>>)
        .await
        .map_err(|e| bollard_err("inspect_ingress_network", e))
}

async fn services(docker: &Docker) -> Result<Vec<Service>, Status> {
    docker
        .list_services(None::<ListServicesOptions<String>>)
        .await
        .map_err(|e| bollard_err("list_ingress_services", e))
}

/// Returns false only for standalone containers or non-overlay networks.
/// Existing manual attachments migrate through a normal service rollout.
pub async fn reconcile(
    docker: &Docker,
    container_id: &str,
    network_name: &str,
    attach: bool,
) -> Result<bool, Status> {
    let network = inspect_network(docker, network_name).await?;
    if network.driver.as_deref() != Some("overlay") || network.scope.as_deref() != Some("swarm") {
        return Ok(false);
    }
    let container = docker
        .inspect_container(container_id, None::<InspectContainerOptions>)
        .await
        .map_err(|e| bollard_err("inspect_container", e))?;
    let labels = container
        .config
        .and_then(|config| config.labels)
        .unwrap_or_default();
    let Some(service_id) = labels.get("com.docker.swarm.service.id") else {
        return Ok(false);
    };
    // This RPC does not grant arbitrary infrastructure service-update access.
    if labels
        .get("com.docker.swarm.service.name")
        .map(String::as_str)
        != Some("ploydok_caddy")
        || labels.get("ploydok.component").map(String::as_str) != Some("caddy")
    {
        return Err(Status::failed_precondition(
            "managed_overlay_requires_service_attachment",
        ));
    }
    let pending = AttachmentState::AttachmentPending {
        network: network_name.to_string(),
    };
    timeout(Duration::from_secs(25), async {
        let _lock = ATTACHMENT_LOCK.lock().await;
        reconcile_locked(docker, container_id, service_id, &network, attach).await
    })
    .await
    .map_err(|_| pending.status())?
}

async fn reconcile_locked(
    docker: &Docker,
    container_id: &str,
    service_id: &str,
    network: &Network,
    attach: bool,
) -> Result<bool, Status> {
    let network_name = network
        .name
        .as_deref()
        .ok_or_else(|| Status::failed_precondition("ingress_network_name_missing"))?;
    if network.id.as_deref().is_none_or(str::is_empty) {
        return Err(Status::failed_precondition("ingress_network_id_missing"));
    }
    let current = docker
        .inspect_service(
            service_id,
            Some(InspectServiceOptions {
                insert_defaults: true,
            }),
        )
        .await
        .map_err(|e| bollard_err("inspect_ingress_service", e))?;
    let version = current
        .version
        .and_then(|v| v.index)
        .ok_or_else(|| Status::failed_precondition("ingress_service_version_missing"))?;
    let mut spec = current
        .spec
        .ok_or_else(|| Status::failed_precondition("ingress_service_spec_missing"))?;
    if spec.name.as_deref() != Some("ploydok_caddy") {
        return Err(Status::permission_denied(
            "ingress_service_identity_mismatch",
        ));
    }
    if let Some(state) = collision(
        &inspect_network(docker, network_name).await?,
        container_id,
        &services(docker).await?,
    ) {
        tracing::warn!(state = "address_collision", attachment = ?state, "repairing ingress address collision through service allocation");
    }
    if set_network(&mut spec, network, attach) {
        // Host-published ports require stop-first. Preserve all existing
        // settings, including update policy, mounts, ports and networks.
        docker
            .update_service(
                service_id,
                spec,
                UpdateServiceOptions {
                    version,
                    registry_auth_from: false,
                    rollback: false,
                },
                None,
            )
            .await
            .map_err(|e| {
                // A version conflict is not an idempotent network 409.
                if matches!(
                    e,
                    bollard::errors::Error::DockerResponseServerError {
                        status_code: 409,
                        ..
                    }
                ) {
                    Status::aborted("ingress_service_version_conflict")
                } else {
                    bollard_err("update_ingress_service", e)
                }
            })?;
    }
    // Wait for the actual managed endpoint, not merely an accepted spec.
    // This is rollout convergence, not a retry of unsafe network connect.
    loop {
        let mut filters = HashMap::new();
        filters.insert(
            "label".to_string(),
            vec![format!("com.docker.swarm.service.id={service_id}")],
        );
        filters.insert("status".to_string(), vec!["running".to_string()]);
        let containers = docker
            .list_containers(Some(ListContainersOptions {
                filters,
                ..Default::default()
            }))
            .await
            .map_err(|e| bollard_err("list_ingress_tasks", e))?;
        let actual = inspect_network(docker, network_name).await?;
        for task in containers {
            let Some(id) = task.id else {
                continue;
            };
            let runtime = docker
                .inspect_container(&id, None::<InspectContainerOptions>)
                .await
                .map_err(|e| bollard_err("inspect_ingress_task", e))?;
            if runtime.state.as_ref().and_then(|s| s.running) != Some(true) {
                continue;
            }
            let endpoint = runtime
                .network_settings
                .as_ref()
                .and_then(|n| n.networks.as_ref())
                .and_then(|n| n.get(network_name));
            if attach {
                // A manual attachment has no manager-assigned IPAMConfig.
                let managed = endpoint.is_some_and(|e| {
                    e.network_id == network.id
                        && e.ipam_config
                            .as_ref()
                            .and_then(|c| c.ipv4_address.as_deref())
                            .is_some_and(|ip| !ip.is_empty())
                });
                if !managed {
                    continue;
                }
                if let Some(state) = collision(&actual, &id, &services(docker).await?) {
                    return Err(state.status());
                }
                if actual
                    .containers
                    .as_ref()
                    .and_then(|c| c.get(&id))
                    .and_then(|c| c.ipv4_address.as_deref())
                    .is_some_and(|ip| !address(ip).is_empty())
                {
                    return Ok(true);
                }
            } else if endpoint.is_none() {
                // Old manual endpoints must disappear before network removal.
                let old_present = actual.containers.as_ref().is_some_and(|c| {
                    c.values().any(|e| {
                        e.name
                            .as_deref()
                            .is_some_and(|name| name.starts_with("ploydok_caddy."))
                    })
                });
                if !old_present {
                    return Ok(true);
                }
            }
        }
        sleep(Duration::from_millis(250)).await;
    }
}
