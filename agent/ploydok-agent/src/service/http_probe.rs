// SPDX-License-Identifier: AGPL-3.0-only

//! A content-addressed, agent-owned executable volume keeps Docker's native
//! health state available even in scratch/distroless images. The probe runs
//! only for Docker healthchecks. No image entrypoint or image layer is changed.

use std::{collections::HashMap, io::Read};

use bollard::{
    container::{
        Config, CreateContainerOptions, DownloadFromContainerOptions, RemoveContainerOptions,
        UploadToContainerOptions,
    },
    models::{HealthConfig, HostConfig, Mount, MountTypeEnum, MountVolumeOptions, ServiceSpec},
    volume::CreateVolumeOptions,
    Docker,
};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tonic::Status;

use super::bollard_err;

pub const DIRECTORY: &str = "/__ploydok_health";
pub const EXECUTABLE: &str = "/__ploydok_health/probe";
pub const BINARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ploydok-http-probe"));
const HEALTH_LABEL: &str = "ploydok.native-http-healthcheck";
static READY: Mutex<Option<String>> = Mutex::const_new(None);

pub fn is_managed(test: &[String]) -> bool {
    test.first().map(String::as_str) == Some("PLOYDOK-HTTP")
}

/// Repeated at the gRPC boundary, including under a permissive dev validator.
/// Fields are arguments, never interpolated into a new shell command.
pub fn validate(test: &[String]) -> Result<(), Status> {
    if !is_managed(test) {
        return Ok(());
    }
    let valid = test.len() == 3
        && test[1].len() <= 5
        && test[1].parse::<u16>().is_ok_and(|port| port > 0)
        && test[1].bytes().all(|byte| byte.is_ascii_digit())
        && test[2].starts_with('/')
        && test[2].len() <= 512
        && !test[2].bytes().any(|byte| byte < 0x20 || byte == 0x7f);
    if !valid {
        return Err(Status::invalid_argument("healthcheck impossible: PLOYDOK-HTTP requires a port 1..65535, an HTTP path without control characters (max 512 bytes), with an agent-owned shell fallback"));
    }
    Ok(())
}

pub fn docker_test(test: &[String]) -> Vec<String> {
    if is_managed(test) {
        vec![
            "CMD".into(),
            EXECUTABLE.into(),
            "auto".into(),
            test[1].clone(),
            test[2].clone(),
        ]
    } else {
        test.to_vec()
    }
}

pub fn mount(volume: &str, read_only: bool) -> Mount {
    Mount {
        typ: Some(MountTypeEnum::VOLUME),
        source: Some(volume.into()),
        target: Some(DIRECTORY.into()),
        read_only: Some(read_only),
        volume_options: Some(MountVolumeOptions {
            no_copy: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    }
}

pub fn attach_service(spec: &mut ServiceSpec, volume: &str) {
    if let Some(container) = spec
        .task_template
        .as_mut()
        .and_then(|task| task.container_spec.as_mut())
    {
        container
            .mounts
            .get_or_insert_default()
            .push(mount(volume, true));
    }
}

/// Docker emits `Healthcheck`; Bollard 0.17 only decodes `HealthCheck`.
/// Keep the managed contract in container labels so historical-image updates
/// and scaling cannot silently drop the native gate on an inspect/update trip.
pub fn remember_service_healthcheck(spec: &mut ServiceSpec) {
    if let Some(container) = spec
        .task_template
        .as_mut()
        .and_then(|t| t.container_spec.as_mut())
    {
        if let Some(health) = container.health_check.as_ref() {
            container
                .labels
                .get_or_insert_default()
                .insert(HEALTH_LABEL.into(), serde_json::json!(health).to_string());
        }
    }
}

pub fn restore_service_healthcheck(spec: &mut ServiceSpec) -> Result<(), Status> {
    let Some(container) = spec
        .task_template
        .as_mut()
        .and_then(|t| t.container_spec.as_mut())
    else {
        return Ok(());
    };
    if container.health_check.is_some() {
        return Ok(());
    }
    let Some(saved) = container.labels.as_ref().and_then(|l| l.get(HEALTH_LABEL)) else {
        return Ok(());
    };
    let health: HealthConfig = serde_json::from_str(saved).map_err(|e| {
        Status::failed_precondition(format!(
            "healthcheck impossible: invalid saved native HTTP contract: {e}"
        ))
    })?;
    let test = health.test.as_deref().unwrap_or_default();
    if test.len() != 5 || test[0] != "CMD" || test[1] != EXECUTABLE || test[2] != "auto" {
        return Err(Status::failed_precondition(
            "healthcheck impossible: saved contract is not an agent-owned native HTTP probe",
        ));
    }
    validate(&["PLOYDOK-HTTP".into(), test[3].clone(), test[4].clone()])?;
    container.health_check = Some(health);
    Ok(())
}

pub fn validate_mounts<'a>(
    test: &[String],
    targets: impl Iterator<Item = &'a str>,
) -> Result<(), Status> {
    if is_managed(test)
        && targets.into_iter().any(|path| {
            path == DIRECTORY
                || path.starts_with(&format!("{DIRECTORY}/"))
                || path == "/"
                || path.split('/').any(|part| part == "." || part == "..")
        })
    {
        return Err(Status::invalid_argument("healthcheck impossible: an application mount overlaps the reserved probe directory /__ploydok_health"));
    }
    Ok(())
}

pub fn archive() -> Result<Vec<u8>, Status> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(BINARY.len() as u64);
    header.set_mode(0o555);
    header.set_uid(0);
    header.set_gid(0);
    header.set_cksum();
    tar.append_data(&mut header, "probe", BINARY)
        .map_err(|e| Status::internal(format!("healthcheck archive: {e}")))?;
    tar.into_inner()
        .map_err(|e| Status::internal(format!("healthcheck archive: {e}")))
}

fn matches_archive(data: &[u8]) -> Result<bool, Status> {
    let mut archive = tar::Archive::new(data);
    for entry in archive
        .entries()
        .map_err(|e| Status::internal(e.to_string()))?
    {
        let mut entry = entry.map_err(|e| Status::internal(e.to_string()))?;
        let mut contents = Vec::new();
        (&mut entry)
            .take((BINARY.len() + 1) as u64)
            .read_to_end(&mut contents)
            .map_err(|e| Status::internal(e.to_string()))?;
        if contents == BINARY
            && entry.header().mode().ok() == Some(0o555)
            && entry.header().uid().ok() == Some(0)
            && entry.header().gid().ok() == Some(0)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The short-lived staging container is never started. Docker's archive API
/// populates its volume, which runtime containers mount read-only. Existing
/// content is verified before reuse, including after an agent restart.
pub async fn ensure(docker: &Docker, image: &str) -> Result<String, Status> {
    let mut ready = READY.lock().await;
    let image_info = docker
        .inspect_image(image)
        .await
        .map_err(|e| bollard_err("healthcheck inspect_image", e))?;
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    if image_info.architecture.as_deref() != Some(architecture)
        || image_info.os.as_deref() != Some("linux")
    {
        return Err(Status::failed_precondition(format!("healthcheck impossible: static probe requires a native linux/{architecture} image, got {:?}/{:?}", image_info.os, image_info.architecture)));
    }
    if let Some(volume) = ready.as_ref() {
        match docker.inspect_volume(volume).await {
            Ok(_) => return Ok(volume.clone()),
            Err(bollard::errors::Error::DockerResponseServerError {
                status_code: 404, ..
            }) => {}
            Err(e) => return Err(bollard_err("healthcheck inspect cached volume", e)),
        }
        *ready = None;
    }
    let digest = hex::encode(Sha256::digest(BINARY));
    let volume = format!("ploydok-health-probe-{architecture}-{}", &digest[..24]);
    docker
        .create_volume(CreateVolumeOptions {
            name: volume.clone(),
            driver: "local".into(),
            labels: HashMap::from([
                ("ploydok.kind".into(), "health-probe".into()),
                ("ploydok.probe.sha256".into(), digest),
            ]),
            ..Default::default()
        })
        .await
        .map_err(|e| bollard_err("healthcheck create_volume", e))?;
    let helper = docker
        .create_container(
            None::<CreateContainerOptions<String>>,
            Config {
                image: Some(image.to_string()),
                cmd: Some(vec![EXECUTABLE.into()]),
                labels: Some(HashMap::from([(
                    "ploydok.kind".into(),
                    "health-probe".into(),
                )])),
                host_config: Some(HostConfig {
                    mounts: Some(vec![mount(&volume, false)]),
                    network_mode: Some("none".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| bollard_err("healthcheck create staging container", e))?;
    let result = async {
        let mut stream = docker.download_from_container(
            &helper.id,
            Some(DownloadFromContainerOptions { path: EXECUTABLE }),
        );
        let mut data = Vec::new();
        let mut missing = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => {
                    data.extend_from_slice(&chunk);
                    if data.len() > BINARY.len() + 65536 {
                        return Err(Status::failed_precondition(
                            "healthcheck impossible: managed probe volume contains oversized data",
                        ));
                    }
                }
                Err(bollard::errors::Error::DockerResponseServerError {
                    status_code: 404, ..
                }) => {
                    missing = true;
                    break;
                }
                Err(e) => return Err(bollard_err("healthcheck verify volume", e)),
            }
        }
        if !missing {
            if !matches_archive(&data)? {
                return Err(Status::failed_precondition(
                    "healthcheck impossible: managed probe volume failed integrity verification",
                ));
            }
            return Ok(());
        }
        docker
            .upload_to_container(
                &helper.id,
                Some(UploadToContainerOptions {
                    path: DIRECTORY,
                    no_overwrite_dir_non_dir: "true",
                }),
                archive()?.into(),
            )
            .await
            .map_err(|e| bollard_err("healthcheck install static probe", e))
    }
    .await;
    let cleanup = docker
        .remove_container(
            &helper.id,
            Some(RemoveContainerOptions {
                force: true,
                v: true,
                ..Default::default()
            }),
        )
        .await;
    result?;
    cleanup.map_err(|e| bollard_err("healthcheck remove staging container", e))?;
    *ready = Some(volume.clone());
    Ok(volume)
}
