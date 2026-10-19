// SPDX-License-Identifier: AGPL-3.0-only
use bollard::models::{Network, Service};
use ploydok_agent::service::caddy_runtime::{reconcile_locked, runtime_config};
use ploydok_agent::service::ingress_network::{
    collision, has_workloads, reconcile, status, AttachmentState,
};
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
fn detects_ipv6_collision_when_ipv4_is_distinct() {
    let mut net = network();
    net.containers
        .as_mut()
        .unwrap()
        .get_mut("old")
        .unwrap()
        .ipv6_address = Some("fd00::2/64".into());
    net.containers
        .as_mut()
        .unwrap()
        .get_mut("app")
        .unwrap()
        .ipv6_address = Some("fd00::2/64".into());
    assert!(
        matches!(collision(&net, "old", &[]), Some(AttachmentState::AddressCollision { address, .. }) if address == "fd00::2")
    );
}

fn descriptor() -> Value {
    json!({"Name": "ploydok_caddy", "Labels": {"ploydok.component": "caddy"},
        "Mode": {"Replicated": {"Replicas": 1}},
        "TaskTemplate": {"ContainerSpec": {"Image": "caddy@sha256:abc", "Labels": {"ploydok.component": "caddy"}, "Mounts": [{"Type": "volume", "Source": "ploydok_caddy-data", "Target": "/data"}, {"Type": "volume", "Source": "ploydok_caddy-admin-socket", "Target": "/run/caddy-admin"}]},
            "Networks": [{"Target": "control"}, {"Target": "overlay-id"}]},
        "EndpointSpec": {"Ports": [{"TargetPort": 80, "PublishedPort": 80, "Protocol": "tcp", "PublishMode": "host"}]}})
}

#[test]
fn runtime_contract_preserves_ports_mounts_and_resume_but_excludes_network_churn() {
    let mut spec: bollard::models::ServiceSpec = serde_json::from_value(descriptor()).unwrap();
    let original = runtime_config(&spec).unwrap();
    spec.task_template.as_mut().unwrap().networks = Some(vec![]);
    assert_eq!(runtime_config(&spec).unwrap(), original);
    assert!(original.cmd.as_ref().unwrap().contains(&"--resume".into()));
    let host = original.host_config.as_ref().unwrap();
    assert_eq!(host.mounts.as_ref().unwrap().len(), 2);
    assert_eq!(
        host.port_bindings.as_ref().unwrap()["80/tcp"]
            .as_ref()
            .unwrap()[0]
            .host_port
            .as_deref(),
        Some("80")
    );
    assert!(!original
        .labels
        .as_ref()
        .unwrap()
        .contains_key("com.docker.swarm.service.id"));
    spec.task_template
        .as_mut()
        .unwrap()
        .container_spec
        .as_mut()
        .unwrap()
        .image = Some("caddy@sha256:def".into());
    assert_ne!(runtime_config(&spec).unwrap().labels, original.labels);
}

#[derive(Default)]
struct State {
    calls: Vec<String>,
    spec: Value,
    runtime: Option<Value>,
    attached: bool,
    collision: bool,
    dev: bool,
}

async fn fixture() -> (
    bollard::Docker,
    Arc<Mutex<State>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(State {
        spec: descriptor(),
        ..Default::default()
    }));
    let seen = Arc::clone(&state);
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
            let line = header.lines().next().unwrap();
            let path = line.split_whitespace().nth(1).unwrap();
            let body = if length > 0 {
                serde_json::from_slice(&request[header_end..header_end + length]).unwrap()
            } else {
                Value::Null
            };
            let (code, response) = {
                let mut s = seen.lock().unwrap();
                s.calls.push(line.to_string());
                if line.starts_with("POST ") && path.contains("/services/ploydok_caddy/update") {
                    s.spec = body;
                    (200, json!({}))
                } else if path.contains("/services/ploydok_caddy") {
                    (
                        200,
                        json!({"ID": "caddy-service", "Version": {"Index": 42}, "Spec": s.spec}),
                    )
                } else if path.contains("/images/") {
                    (200, json!({"Id": "image"}))
                } else if path.contains("/containers/create") {
                    assert!(!body["Labels"]
                        .as_object()
                        .unwrap()
                        .contains_key("com.docker.swarm.service.id"));
                    s.runtime = Some(
                        json!({"Id": "runtime", "Config": {"Labels": body["Labels"]}, "State": {"Running": false}}),
                    );
                    s.attached = true;
                    (201, json!({"Id": "runtime", "Warnings": []}))
                } else if path.contains("/containers/runtime/start") {
                    s.runtime.as_mut().unwrap()["State"]["Running"] = json!(true);
                    (204, Value::Null)
                } else if path.contains("/containers/ploydok-caddy/json")
                    || path.contains("/containers/runtime/json")
                {
                    s.runtime
                        .clone()
                        .map(|r| (200, r))
                        .unwrap_or((404, json!({"message": "no such container"})))
                } else if path.contains("/containers/old/json") {
                    (
                        200,
                        json!({"Config": {"Labels": {"com.docker.swarm.service.id": "caddy-service", "com.docker.swarm.service.name": "ploydok_caddy", "ploydok.component": "caddy"}}}),
                    )
                } else if path.contains("/containers/json") {
                    if path.contains("com.docker.swarm.service.name") {
                        (200, json!([]))
                    } else {
                        (
                            200,
                            json!([{"Id": "runtime", "Labels": if s.dev { json!({"ploydok.service": "caddy"}) } else { s.runtime.as_ref().map(|r| r["Config"]["Labels"].clone()).unwrap_or_else(|| json!({"ploydok.component": "caddy"})) }}]),
                        )
                    }
                } else if path.contains("/networks/") && path.contains("/disconnect") {
                    assert_eq!(body["Container"], "runtime");
                    s.attached = false;
                    (200, json!({}))
                } else if path.contains("/networks/") && path.contains("/connect") {
                    assert_eq!(body["Container"], "runtime");
                    s.attached = true;
                    (200, json!({}))
                } else if path.contains("/networks/") {
                    let mut net = network();
                    net.containers.as_mut().unwrap().remove("old");
                    if s.attached {
                        net.containers.as_mut().unwrap().insert(
                            "runtime".into(),
                            bollard::models::NetworkContainer {
                                ipv4_address: Some(
                                    if s.collision {
                                        "10.0.8.2/24"
                                    } else {
                                        "10.0.8.7/24"
                                    }
                                    .into(),
                                ),
                                ..Default::default()
                            },
                        );
                    }
                    (200, serde_json::to_value(net).unwrap())
                } else if path.contains("/networks") && s.dev {
                    (
                        200,
                        json!([{"Id": "bridge", "Name": "ploydok-public", "Driver": "bridge"}]),
                    )
                } else if path.contains("/networks") {
                    (
                        200,
                        json!([{"Id": "control", "Name": "ploydok_ploydok", "Driver": "overlay", "Attachable": true}, {"Id": "overlay-id", "Name": "ploydok-swarm-proj-test", "Driver": "overlay", "Attachable": true}]),
                    )
                } else if path.contains("/services") {
                    (
                        200,
                        json!([{"ID": "app-service", "Endpoint": services()[0].endpoint}, {"ID": "caddy-service", "Spec": s.spec}]),
                    )
                } else {
                    panic!("unexpected Docker call: {header}");
                }
            };
            let body = response.to_string();
            stream.write_all(format!("HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", if code == 204 {0} else {body.len()}, if code == 204 {""} else {&body}).as_bytes()).await.unwrap();
        }
    });
    (
        bollard::Docker::connect_with_http(&url, 5, bollard::API_DEFAULT_VERSION).unwrap(),
        state,
        server,
    )
}

#[tokio::test]
async fn migrates_managed_task_once_into_standalone_manager_allocated_endpoint() {
    let (docker, state, server) = fixture().await;
    assert!(reconcile(&docker, "old", "ploydok-swarm-proj-test", true)
        .await
        .unwrap());
    let s = state.lock().unwrap();
    assert_eq!(s.spec["Mode"]["Replicated"]["Replicas"], 0);
    assert_eq!(s.calls.iter().filter(|c| c.contains("/update")).count(), 1);
    assert!(s.runtime.as_ref().unwrap()["State"]["Running"]
        .as_bool()
        .unwrap());
    server.abort();
}

#[tokio::test]
async fn live_join_leave_and_stack_network_reset_never_replace_runtime() {
    let (docker, state, server) = fixture().await;
    assert_eq!(
        reconcile_locked(&docker).await.unwrap().as_deref(),
        Some("runtime")
    );
    state.lock().unwrap().calls.clear();
    reconcile(&docker, "runtime", "ploydok-swarm-proj-test", false)
        .await
        .unwrap();
    reconcile(&docker, "runtime", "ploydok-swarm-proj-test", true)
        .await
        .unwrap();
    // A stack redeploy drops dynamic memberships from its descriptor.
    state.lock().unwrap().spec["TaskTemplate"]["Networks"] = json!([{"Target": "control"}]);
    assert_eq!(
        reconcile_locked(&docker).await.unwrap().as_deref(),
        Some("runtime")
    );
    let s = state.lock().unwrap();
    assert!(!s.calls.iter().any(|c| c.contains("/update")
        || c.contains("/create")
        || c.contains("/start")
        || c.starts_with("DELETE ")));
    server.abort();
}

#[tokio::test]
async fn existing_collision_is_rejected_on_idempotent_join_and_reported_read_only() {
    let (docker, state, server) = fixture().await;
    reconcile_locked(&docker).await.unwrap();
    state.lock().unwrap().collision = true;
    let error = reconcile(&docker, "runtime", "ploydok-swarm-proj-test", true)
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    let typed: Value = serde_json::from_str(error.message()).unwrap();
    assert_eq!(typed["state"], "address_collision");
    state.lock().unwrap().calls.clear();
    let report = status(&docker).await.unwrap();
    assert!(report.overlay_inventory_complete);
    assert_eq!(report.project_overlays[0].name, "ploydok-swarm-proj-test");
    assert!(report.project_overlays[0].has_workloads);
    assert_eq!(report.issues[0].state, "address_collision");
    assert_eq!(report.issues[0].network, "ploydok-swarm-proj-test");
    assert_eq!(report.issues[0].address, "10.0.8.2");
    assert_eq!(report.issues[0].conflicting_endpoint, "vip:app-service");
    assert!(state
        .lock()
        .unwrap()
        .calls
        .iter()
        .all(|c| c.starts_with("GET ")));
    server.abort();
}

#[tokio::test]
async fn readiness_supports_compose_caddy_without_swarm() {
    let (docker, state, server) = fixture().await;
    state.lock().unwrap().dev = true;
    let report = status(&docker).await.unwrap();
    assert!(report.issues.is_empty());
    assert_eq!(report.container_id, "runtime");
    assert!(!state
        .lock()
        .unwrap()
        .calls
        .iter()
        .any(|c| c.contains("/services")));
    server.abort();
}

#[tokio::test]
async fn readiness_gates_runtime_image_convergence_without_mutation() {
    let (docker, state, server) = fixture().await;
    reconcile_locked(&docker).await.unwrap();
    assert!(status(&docker).await.unwrap().issues.is_empty());
    state.lock().unwrap().spec["TaskTemplate"]["ContainerSpec"]["Image"] =
        json!("caddy@sha256:def");
    state.lock().unwrap().calls.clear();
    let error = status(&docker).await.unwrap_err();
    assert_eq!(error.message(), "ingress_runtime_revision_pending");
    assert!(state
        .lock()
        .unwrap()
        .calls
        .iter()
        .all(|c| c.starts_with("GET ")));
    server.abort();
}

#[test]
fn overlay_inventory_keeps_workloads_and_service_references_but_ignores_caddy_and_lb() {
    let mut net: Network = serde_json::from_value(json!({
        "Id": "overlay-id", "Name": "ploydok-swarm-proj-test", "Driver": "overlay",
        "Containers": {
            "runtime": {"Name": "ploydok-caddy"},
            "lb-overlay-id": {"Name": "ploydok-swarm-proj-test-endpoint"}
        }
    }))
    .unwrap();
    assert!(!has_workloads(&net, "runtime", &[]));
    assert!(has_workloads(&net, "runtime", &services()));
    let pending: Vec<Service> = serde_json::from_value(json!([{
        "Spec": {"Name": "app", "TaskTemplate": {"Networks": [{"Target": "overlay-id"}]}}
    }]))
    .unwrap();
    assert!(has_workloads(&net, "runtime", &pending));
    net.containers
        .as_mut()
        .unwrap()
        .insert("workload".into(), Default::default());
    assert!(has_workloads(&net, "runtime", &[]));
}
