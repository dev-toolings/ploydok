// SPDX-License-Identifier: AGPL-3.0-only
// Swarm tasks must receive overlay addresses from the manager, never local IPAM.
use super::bollard_err;
use bollard::container::InspectContainerOptions;
use bollard::models::{Network, Service};
use bollard::network::{ConnectNetworkOptions, DisconnectNetworkOptions, InspectNetworkOptions};
use bollard::service::ListServicesOptions;
use bollard::Docker;
use serde::Serialize;
use tonic::Status;

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
    let caddy = endpoints.get(caddy_id)?;
    for caddy_ip in [caddy.ipv4_address.as_deref(), caddy.ipv6_address.as_deref()]
        .into_iter()
        .flatten()
        .map(address)
        .filter(|ip| !ip.is_empty())
    {
        let conflict = endpoints
            .iter()
            .find_map(|(id, endpoint)| {
                (id != caddy_id
                    && [
                        endpoint.ipv4_address.as_deref(),
                        endpoint.ipv6_address.as_deref(),
                    ]
                    .into_iter()
                    .flatten()
                    .map(address)
                    .any(|ip| ip == caddy_ip))
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
            });
        if let Some(conflicting_endpoint) = conflict {
            return Some(AttachmentState::AddressCollision {
                network: network.name.clone().unwrap_or_default(),
                address: caddy_ip.to_string(),
                conflicting_endpoint,
            });
        }
    }
    None
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

fn is_caddy(labels: &std::collections::HashMap<String, String>) -> bool {
    labels
        .get("ploydok.component")
        .or_else(|| labels.get("ploydok.service"))
        .map(String::as_str)
        == Some("caddy")
}

/// Managed tasks must never use local IPAM. Migrate legacy Caddy once, then
/// connect/disconnect the standalone runtime through manager AttachNetwork.
pub async fn reconcile(
    docker: &Docker,
    container_id: &str,
    network_name: &str,
    attach: bool,
) -> Result<bool, Status> {
    let _lock = super::caddy_runtime::LOCK.lock().await;
    let network = inspect_network(docker, network_name).await?;
    let container = docker
        .inspect_container(container_id, None::<InspectContainerOptions>)
        .await
        .map_err(|e| bollard_err("inspect_container", e))?;
    let labels = container.config.and_then(|c| c.labels).unwrap_or_default();
    let managed = labels.contains_key("com.docker.swarm.service.id");
    let caddy = is_caddy(&labels);
    if managed && !caddy && network.driver.as_deref() == Some("overlay") {
        return Err(Status::failed_precondition(
            "managed_overlay_requires_standalone_ingress",
        ));
    }
    if !caddy {
        return Ok(false);
    }
    let id = if managed {
        if labels
            .get("com.docker.swarm.service.name")
            .map(String::as_str)
            != Some("ploydok_caddy")
        {
            return Err(Status::permission_denied(
                "ingress_service_identity_mismatch",
            ));
        }
        super::caddy_runtime::reconcile_locked(docker)
            .await?
            .ok_or_else(|| Status::failed_precondition("ingress_descriptor_missing"))?
    } else {
        container_id.to_string()
    };
    let actual = inspect_network(docker, network_name).await?;
    let present = actual
        .containers
        .as_ref()
        .is_some_and(|c| c.contains_key(&id));
    if attach && !present {
        docker
            .connect_network(
                network_name,
                ConnectNetworkOptions {
                    container: id.clone(),
                    endpoint_config: Default::default(),
                },
            )
            .await
            .map_err(|e| bollard_err("connect_ingress_network", e))?;
    } else if !attach && present {
        docker
            .disconnect_network(
                network_name,
                DisconnectNetworkOptions {
                    container: id.clone(),
                    force: true,
                },
            )
            .await
            .map_err(|e| bollard_err("disconnect_ingress_network", e))?;
    }
    if attach && network.scope.as_deref() == Some("swarm") {
        let actual = inspect_network(docker, network_name).await?;
        if let Some(state) = collision(&actual, &id, &services(docker).await?) {
            return Err(state.status());
        }
        if !actual
            .containers
            .as_ref()
            .is_some_and(|c| c.contains_key(&id))
        {
            return Err(AttachmentState::AttachmentPending {
                network: network_name.into(),
            }
            .status());
        }
    }
    Ok(true)
}

/// Treat unknown endpoints and service references as live consumers. Single-node
/// Swarm is enforced elsewhere, so inspect covers all workload endpoints.
pub fn has_workloads(network: &Network, caddy_id: &str, services: &[Service]) -> bool {
    let name = network.name.as_deref().unwrap_or_default();
    let lb_name = format!("{name}-endpoint");
    network.containers.as_ref().is_some_and(|endpoints| {
        endpoints.iter().any(|(id, endpoint)| {
            id != caddy_id && !(id.starts_with("lb-") && endpoint.name.as_deref() == Some(&lb_name))
        })
    }) || services.iter().any(|service| {
        if service.spec.as_ref().and_then(|spec| spec.name.as_deref()) == Some("ploydok_caddy") {
            return false;
        }
        let has_vip = service
            .endpoint
            .as_ref()
            .and_then(|endpoint| endpoint.virtual_ips.as_ref())
            .is_some_and(|vips| vips.iter().any(|vip| vip.network_id == network.id));
        has_vip
            || service.spec.as_ref().is_some_and(|spec| {
                spec.task_template
                    .as_ref()
                    .and_then(|task| task.networks.as_ref())
                    .is_some_and(|networks| {
                        networks
                            .iter()
                            .any(|n| n.target == network.id || n.target.as_deref() == Some(name))
                    })
            })
    })
}

/// Read-only, uncached inspection of every project overlay joined by Caddy.
/// No repair or lifecycle operation is permitted on this readiness path.
pub async fn status(
    docker: &Docker,
) -> Result<ploydok_proto::agent::IngressStatusResponse, Status> {
    use bollard::container::ListContainersOptions;
    use bollard::network::ListNetworksOptions;
    use ploydok_proto::agent::{IngressNetworkIssue, IngressProjectOverlay, IngressStatusResponse};
    use std::collections::HashMap;
    let containers = docker
        .list_containers(Some(ListContainersOptions::<String> {
            filters: HashMap::from([("label".into(), vec!["ploydok.kind=infra".into()])]),
            ..Default::default()
        }))
        .await
        .map_err(|e| bollard_err("list_ingress_containers", e))?;
    let containers: Vec<_> = containers
        .into_iter()
        .filter(|c| c.labels.as_ref().is_some_and(is_caddy))
        .collect();
    if containers.len() != 1 {
        return Err(Status::failed_precondition(
            "ingress_requires_one_running_caddy",
        ));
    }
    let id = containers[0]
        .id
        .as_deref()
        .ok_or_else(|| Status::failed_precondition("ingress_container_id_missing"))?;
    let networks = docker
        .list_networks(None::<ListNetworksOptions<String>>)
        .await
        .map_err(|e| bollard_err("list_ingress_networks", e))?;
    let services = if networks
        .iter()
        .any(|n| n.driver.as_deref() == Some("overlay"))
    {
        services(docker).await?
    } else {
        Vec::new()
    };
    let mut issues = Vec::new();
    let mut project_overlays = Vec::new();
    for network in &networks {
        if network.driver.as_deref() != Some("overlay")
            || !network
                .name
                .as_deref()
                .is_some_and(|n| n.starts_with("ploydok-swarm-proj-"))
        {
            continue;
        }
        let name = network
            .name
            .as_deref()
            .ok_or_else(|| Status::failed_precondition("ingress_network_name_missing"))?;
        let actual = inspect_network(docker, name).await?;
        project_overlays.push(IngressProjectOverlay {
            name: name.into(),
            has_workloads: has_workloads(&actual, id, &services),
        });
        if let Some(AttachmentState::AddressCollision {
            network,
            address,
            conflicting_endpoint,
        }) = collision(&actual, id, &services)
        {
            issues.push(IngressNetworkIssue {
                state: "address_collision".into(),
                network,
                address,
                conflicting_endpoint,
            });
        }
    }
    // Report collisions even during migration. Once allocation is clean,
    // readiness also gates the asynchronous descriptor-to-runtime convergence.
    if issues.is_empty() {
        if let Some(spec) = services
            .iter()
            .filter_map(|s| s.spec.as_ref())
            .find(|s| s.name.as_deref() == Some("ploydok_caddy"))
        {
            let desired = super::caddy_runtime::runtime_config(spec)?;
            let revision = super::caddy_runtime::REVISION;
            if containers[0].labels.as_ref().and_then(|l| l.get(revision))
                != desired.labels.as_ref().and_then(|l| l.get(revision))
            {
                return Err(Status::failed_precondition(
                    "ingress_runtime_revision_pending",
                ));
            }
        }
    }
    Ok(IngressStatusResponse {
        container_id: id.into(),
        issues,
        project_overlays,
        overlay_inventory_complete: true,
    })
}
