// SPDX-License-Identifier: AGPL-3.0-only
use bollard::models::{Network, Service, ServiceSpec};
use ploydok_agent::service::ingress_network::{collision, reconcile, set_network, AttachmentState};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn network() -> Network {
    serde_json::from_value(json!({
        "Id": "overlay-id", "Name": "ploydok-swarm-proj-test", "Driver": "overlay", "Scope": "swarm",
        "Containers": {"old": {"Name": "ploydok_caddy.1.old", "IPv4Address": "10.0.8.2/24"},
                       "app": {"Name": "app.1.task", "IPv4Address": "10.0.8.3/24"}}
    })).unwrap()
}

fn services() -> Vec<Service> {
    serde_json::from_value(json!([{"ID": "app-service", "Endpoint": {"VirtualIPs": [
        {"NetworkID": "overlay-id", "Addr": "10.0.8.2/24"}
    ]}}]))
    .unwrap()
}

#[test]
fn detects_vip_collision_on_the_same_overlay() {
    assert_eq!(
        collision(&network(), "old", &services()),
        Some(AttachmentState::AddressCollision {
            network: "ploydok-swarm-proj-test".into(),
            address: "10.0.8.2".into(),
            conflicting_endpoint: "vip:app-service".into()
        })
    );
}

#[test]
fn detects_task_address_collision() {
    let mut network = network();
    network
        .containers
        .as_mut()
        .unwrap()
        .get_mut("app")
        .unwrap()
        .ipv4_address = Some("10.0.8.2/24".into());
    assert!(
        matches!(collision(&network, "old", &[]), Some(AttachmentState::AddressCollision { conflicting_endpoint, .. }) if conflicting_endpoint == "app")
    );
}

#[test]
fn ignores_vips_on_other_overlays_and_non_colliding_tasks() {
    let mut services = services();
    services[0]
        .endpoint
        .as_mut()
        .unwrap()
        .virtual_ips
        .as_mut()
        .unwrap()[0]
        .network_id = Some("other-overlay".into());
    assert_eq!(collision(&network(), "old", &services), None);
}

#[test]
fn changes_only_network_membership_and_is_idempotent() {
    let mut spec: ServiceSpec = serde_json::from_value(json!({
        "Name": "ploydok_caddy", "Labels": {"ploydok.kind": "infra"},
        "TaskTemplate": {"ContainerSpec": {"Image": "caddy@sha256:abc", "Mounts": [{"Type": "volume", "Source": "data", "Target": "/data"}]},
            "Networks": [{"Target": "control", "Aliases": ["caddy"]}]},
        "EndpointSpec": {"Ports": [{"TargetPort": 80, "PublishedPort": 80, "PublishMode": "host"}]},
        "UpdateConfig": {"Order": "stop-first"}
    })).unwrap();
    let original = spec.clone();
    assert!(set_network(&mut spec, &network(), true));
    assert!(!set_network(&mut spec, &network(), true));
    assert_eq!(spec.endpoint_spec, original.endpoint_spec);
    assert_eq!(spec.update_config, original.update_config);
    assert_eq!(
        spec.task_template.as_ref().unwrap().container_spec,
        original.task_template.as_ref().unwrap().container_spec
    );
    assert!(set_network(&mut spec, &network(), false));
    assert!(!set_network(&mut spec, &network(), false));
    assert_eq!(spec, original);
}

// Exercise the real Docker HTTP calls, including migrating an already-connected
// colliding container. The fake rejects container connect/disconnect implicitly.
async fn fixture(
    rollout_ip: &'static str,
) -> (
    bollard::Docker,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let updates = Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen = Arc::clone(&updates);
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let header_end = loop {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buf[..n]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let header = String::from_utf8(request[..header_end].to_vec()).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|n| n.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + length {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                request.extend_from_slice(&buf[..n]);
            }
            let path = header
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let latest = seen.lock().unwrap().last().cloned();
            let updated = latest.is_some();
            let attached = latest.as_ref().is_none_or(|spec| {
                spec["TaskTemplate"]["Networks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|n| n["Target"] == "overlay-id")
            });
            let response = if header.starts_with("POST ")
                && path.contains("/services/caddy-service/update")
            {
                let body: Value =
                    serde_json::from_slice(&request[header_end..header_end + length]).unwrap();
                seen.lock().unwrap().push(body);
                json!({})
            } else if path.contains("/networks/") {
                let mut net = network();
                if updated {
                    let endpoint = net.containers.as_mut().unwrap().remove("old").unwrap();
                    if attached {
                        net.containers.as_mut().unwrap().insert(
                            "new".into(),
                            bollard::models::NetworkContainer {
                                ipv4_address: Some(format!("{rollout_ip}/24")),
                                ..endpoint
                            },
                        );
                    }
                }
                serde_json::to_value(net).unwrap()
            } else if path.contains("/containers/old/json") || path.contains("/containers/new/json")
            {
                let networks = if !attached {
                    json!({})
                } else {
                    json!({"ploydok-swarm-proj-test": if updated {
                        json!({"NetworkID": "overlay-id", "IPAMConfig": {"IPv4Address": rollout_ip}})
                    } else { json!({}) }})
                };
                json!({"State": {"Running": true}, "Config": {"Labels": {
                    "com.docker.swarm.service.id": "caddy-service", "com.docker.swarm.service.name": "ploydok_caddy", "ploydok.component": "caddy"
                }}, "NetworkSettings": {"Networks": networks}})
            } else if path.contains("/containers/json") {
                json!([{"Id": if updated {"new"} else {"old"}}])
            } else if path.contains("/services/caddy-service") {
                let spec = latest.unwrap_or_else(|| json!({"Name": "ploydok_caddy", "TaskTemplate": {"Networks": [{"Target": "control", "Aliases": ["caddy"]}]}, "UpdateConfig": {"Order": "stop-first"}}));
                json!({"ID": "caddy-service", "Version": {"Index": 42}, "Spec": spec})
            } else if path.contains("/services") {
                serde_json::to_value(services()).unwrap()
            } else {
                panic!("unexpected Docker call: {header}");
            };
            let body = response.to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
        }
    });
    let docker = bollard::Docker::connect_with_http(&url, 5, bollard::API_DEFAULT_VERSION).unwrap();
    (docker, updates, server)
}

#[tokio::test]
async fn migrates_manual_attachment_and_checks_convergence_without_container_connect() {
    let (docker, updates, server) = fixture("10.0.8.7").await;
    assert!(reconcile(&docker, "old", "ploydok-swarm-proj-test", true)
        .await
        .unwrap());
    let updates = updates.lock().unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(
        updates[0]["TaskTemplate"]["Networks"],
        json!([{"Target": "control", "Aliases": ["caddy"]}, {"Target": "overlay-id"}])
    );
    assert_eq!(updates[0]["UpdateConfig"]["Order"], "stop-first");
    server.abort();
}

#[tokio::test]
async fn repeated_attachment_does_not_restart_caddy() {
    let (docker, updates, server) = fixture("10.0.8.7").await;
    reconcile(&docker, "old", "ploydok-swarm-proj-test", true)
        .await
        .unwrap();
    reconcile(&docker, "new", "ploydok-swarm-proj-test", true)
        .await
        .unwrap();
    assert_eq!(updates.lock().unwrap().len(), 1);
    server.abort();
}

#[tokio::test]
async fn detach_removes_service_membership_before_network_removal() {
    let (docker, updates, server) = fixture("10.0.8.7").await;
    reconcile(&docker, "old", "ploydok-swarm-proj-test", true)
        .await
        .unwrap();
    reconcile(&docker, "new", "ploydok-swarm-proj-test", false)
        .await
        .unwrap();
    let updates = updates.lock().unwrap();
    assert_eq!(updates.len(), 2);
    assert_eq!(
        updates[1]["TaskTemplate"]["Networks"],
        json!([{"Target": "control", "Aliases": ["caddy"]}])
    );
    server.abort();
}

#[tokio::test]
async fn post_rollout_collision_is_a_typed_failed_precondition() {
    let (docker, _, server) = fixture("10.0.8.2").await;
    let error = reconcile(&docker, "old", "ploydok-swarm-proj-test", true)
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    let state: Value = serde_json::from_str(error.message()).unwrap();
    assert_eq!(state["state"], "address_collision");
    assert_eq!(state["address"], "10.0.8.2");
    assert_eq!(state["conflicting_endpoint"], "vip:app-service");
    server.abort();
}
