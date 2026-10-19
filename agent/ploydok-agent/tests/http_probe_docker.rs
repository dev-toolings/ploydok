// SPDX-License-Identifier: AGPL-3.0-only

//! Explicit local Docker checks. Uses the cached image, never builds or pulls.
use bollard::{
    container::{Config, CreateContainerOptions, RemoveContainerOptions},
    models::{HealthConfig, HostConfig},
    Docker,
};
use ploydok_agent::service::http_probe;
use std::{collections::HashMap, time::Duration};

async fn check(server_port: &str, expected: &str) {
    let docker = Docker::connect_with_local_defaults().expect("local Docker");
    let image = "traefik/whoami:v1.10";
    let volume = http_probe::ensure(&docker, image)
        .await
        .expect("install static executable volume");
    let name = format!(
        "ploydok-app-e2e-shellless-{}-{server_port}",
        std::process::id()
    );
    let test = ["PLOYDOK-HTTP", "80", "/"].map(String::from);
    let created = docker
        .create_container(
            Some(CreateContainerOptions {
                name,
                platform: None,
            }),
            Config::<String> {
                image: Some(image.into()),
                user: Some("65532:65532".into()),
                cmd: Some(vec!["--port".into(), server_port.into()]),
                labels: Some(HashMap::from([("ploydok.kind".into(), "test".into())])),
                healthcheck: Some(HealthConfig {
                    test: Some(http_probe::docker_test(&test)),
                    interval: Some(1_000_000_000),
                    timeout: Some(2_000_000_000),
                    retries: Some(1),
                    ..Default::default()
                }),
                host_config: Some(HostConfig {
                    mounts: Some(vec![http_probe::mount(&volume, true)]),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .expect("create scratch whoami");
    let result = async {
        docker
            .start_container::<String>(&created.id, None)
            .await
            .expect("start bounded Docker test");
        for _ in 0..15 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let container = docker
                .inspect_container(&created.id, None)
                .await
                .expect("inspect test");
            let health = container.state.expect("state").health.expect("healthcheck");
            if health.status.as_ref().map(ToString::to_string).as_deref() == Some(expected) {
                return Ok(());
            }
        }
        Err(format!(
            "whoami port {server_port} did not become {expected}"
        ))
    }
    .await;
    docker
        .remove_container(
            &created.id,
            Some(RemoveContainerOptions {
                force: true,
                v: true,
                ..Default::default()
            }),
        )
        .await
        .expect("remove test container");
    result.expect("native Docker health gate");
}

#[tokio::test]
#[ignore = "requires local Docker and cached traefik/whoami:v1.10"]
async fn scratch_whoami_passes_without_shell_or_user_configuration() {
    check("80", "healthy").await;
}

#[tokio::test]
#[ignore = "requires local Docker and cached traefik/whoami:v1.10"]
async fn scratch_image_with_a_non_answering_health_endpoint_is_unhealthy() {
    check("81", "unhealthy").await;
}

#[tokio::test]
#[ignore = "requires an existing single-node local Swarm and cached traefik/whoami:v1.10"]
async fn swarm_keeps_a_real_start_first_health_gate_and_rolls_back_a_bad_shellless_update() {
    use bollard::{
        container::ListContainersOptions,
        models::*,
        service::{InspectServiceOptions, UpdateServiceOptions},
    };
    let docker = Docker::connect_with_local_defaults().expect("Docker");
    let swarm = docker
        .info()
        .await
        .expect("Docker info")
        .swarm
        .expect("Swarm");
    assert_eq!(
        swarm.nodes,
        Some(1),
        "test requires an existing single-node Swarm"
    );
    let image = "traefik/whoami:v1.10";
    let volume = http_probe::ensure(&docker, image)
        .await
        .expect("probe volume");
    let name = format!("ploydok-app-e2e-shellless-swarm-{}", std::process::id());
    let test = ["PLOYDOK-HTTP", "80", "/"].map(String::from);
    let mut spec = ServiceSpec {
        name: Some(name.clone()),
        task_template: Some(TaskSpec {
            container_spec: Some(TaskSpecContainerSpec {
                image: Some(image.into()),
                args: Some(vec!["--port".into(), "80".into()]),
                mounts: Some(vec![http_probe::mount(&volume, true)]),
                health_check: Some(HealthConfig {
                    test: Some(http_probe::docker_test(&test)),
                    interval: Some(1_000_000_000),
                    timeout: Some(2_000_000_000),
                    retries: Some(1),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }),
        mode: Some(ServiceSpecMode {
            replicated: Some(ServiceSpecModeReplicated { replicas: Some(1) }),
            ..Default::default()
        }),
        update_config: Some(ServiceSpecUpdateConfig {
            order: Some(ServiceSpecUpdateConfigOrderEnum::START_FIRST),
            failure_action: Some(ServiceSpecUpdateConfigFailureActionEnum::ROLLBACK),
            monitor: Some(10_000_000_000),
            parallelism: Some(1),
            max_failure_ratio: Some(0.0),
            ..Default::default()
        }),
        rollback_config: Some(ServiceSpecRollbackConfig {
            order: Some(ServiceSpecRollbackConfigOrderEnum::START_FIRST),
            ..Default::default()
        }),
        ..Default::default()
    };
    http_probe::remember_service_healthcheck(&mut spec);
    let created = docker
        .create_service(spec, None)
        .await
        .expect("create bounded test service");
    let id = created.id.expect("service ID");
    let result: Result<(), String> = async {
        let filters = HashMap::from([(
            "label".to_string(),
            vec![format!("com.docker.swarm.service.name={name}")],
        )]);
        let mut ready = false;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let containers = docker
                .list_containers(Some(ListContainersOptions {
                    filters: filters.clone(),
                    ..Default::default()
                }))
                .await
                .map_err(|e| e.to_string())?;
            for container in containers {
                let health = docker
                    .inspect_container(&container.id.expect("container ID"), None)
                    .await
                    .map_err(|e| e.to_string())?
                    .state
                    .and_then(|s| s.health)
                    .and_then(|h| h.status);
                if health == Some(HealthStatusEnum::HEALTHY) {
                    ready = true;
                }
            }
            if ready {
                break;
            }
        }
        if !ready {
            return Err("shellless Swarm service never became healthy".into());
        }
        let current = docker
            .inspect_service(&id, None::<InspectServiceOptions>)
            .await
            .map_err(|e| e.to_string())?;
        let version = current.version.and_then(|v| v.index).expect("version");
        let mut next = current.spec.expect("service spec");
        http_probe::restore_service_healthcheck(&mut next).map_err(|e| e.to_string())?;
        next.task_template
            .as_mut()
            .expect("task")
            .container_spec
            .as_mut()
            .expect("container")
            .args = Some(vec!["--port".into(), "81".into()]);
        docker
            .update_service(
                &id,
                next,
                UpdateServiceOptions {
                    version,
                    registry_auth_from: false,
                    rollback: false,
                },
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        for _ in 0..45 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let containers = docker
                .list_containers(Some(ListContainersOptions {
                    filters: filters.clone(),
                    ..Default::default()
                }))
                .await
                .map_err(|e| e.to_string())?;
            let mut healthy = 0;
            for container in containers {
                let health = docker
                    .inspect_container(&container.id.expect("container ID"), None)
                    .await
                    .map_err(|e| e.to_string())?
                    .state
                    .and_then(|s| s.health)
                    .and_then(|h| h.status);
                if health == Some(HealthStatusEnum::HEALTHY) {
                    healthy += 1;
                }
            }
            let current = docker
                .inspect_service(&id, None::<InspectServiceOptions>)
                .await
                .map_err(|e| e.to_string())?;
            if current
                .update_status
                .and_then(|s| s.state)
                .map(|s| s.to_string())
                .as_deref()
                == Some("rollback_completed")
                && healthy > 0
            {
                return Ok(());
            }
        }
        Err("Swarm did not automatically roll back the unhealthy shellless update".into())
    }
    .await;
    docker
        .delete_service(&id)
        .await
        .expect("remove bounded Swarm test service");
    result.expect("Swarm health gate and automatic rollback");
}
