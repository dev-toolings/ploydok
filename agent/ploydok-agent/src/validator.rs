// SPDX-License-Identifier: AGPL-3.0-only
//
// Validator trait — called by AgentService before each Docker operation.
//
// SECURITY SCOPE
// --------------
// The validator enforces **shape** (registries allowlist, prefix `ploydok-`,
// path prefix, resource ceilings, exec cmd[0] whitelist, age recipient
// format). The service layer also requires a `ploydok.kind` Docker label before
// start/stop/remove. It does **NOT** enforce per-tenant authorisation —
// the API is responsible for ensuring that the caller owns the resource
// before forwarding the RPC. See `service.rs` module-level comment for the
// full security model.
//
// Implementations:
//   - `PermissiveValidator` : no-op, development only.
//   - `StrictValidator`     : production allowlist enforcement (task 2.3).

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};

use ploydok_proto::agent::{
    BuildCachePruneRequest, ContainerCreateRequest, ContainerRemoveRequest, ContainerStartRequest,
    ContainerStopRequest, ExecStart, ImageBuildRequest, ImagePruneRequest, ImagePullRequest,
    ImagePushRequest, ImageRemoveRequest, InspectContainerHealthRequest, ListContainerFilesRequest,
    ListServiceTasksRequest, NetworkConnectRequest, NetworkCreateRequest, NetworkDisconnectRequest,
    NetworkRemoveRequest, ReadContainerFileRequest, RegistryGarbageCollectRequest,
    ServiceRemoveRequest, ServiceRollbackRequest, ServiceScaleRequest, ServiceUpdateImageRequest,
    SwarmServiceSpec,
};
use serde::{Deserialize, Serialize};
use tonic::Status;

/// Validation error type — `Box<Status>` keeps the trait method return type
/// small enough for clippy's `result_large_err` lint (tonic::Status is 176 bytes).
pub type ValidatorResult = Result<(), Box<Status>>;

/// Validation hook called before every RPC.
///
/// Each method receives the decoded request proto and returns `Ok(())` if the
/// operation is allowed, or a boxed [`Status`] (typically `PermissionDenied` /
/// `InvalidArgument`) if it should be rejected.
pub trait Validator: Send + Sync + 'static {
    fn validate_container_create(&self, req: &ContainerCreateRequest) -> ValidatorResult;
    fn validate_container_start(&self, req: &ContainerStartRequest) -> ValidatorResult;
    fn validate_container_stop(&self, req: &ContainerStopRequest) -> ValidatorResult;
    fn validate_container_remove(&self, req: &ContainerRemoveRequest) -> ValidatorResult;
    fn validate_image_pull(&self, req: &ImagePullRequest) -> ValidatorResult;
    fn validate_image_build(&self, req: &ImageBuildRequest) -> ValidatorResult;
    fn validate_image_prune(&self, req: &ImagePruneRequest) -> ValidatorResult;
    fn validate_image_push(&self, req: &ImagePushRequest) -> ValidatorResult;
    fn validate_image_remove(&self, req: &ImageRemoveRequest) -> ValidatorResult;
    fn validate_build_cache_prune(&self, req: &BuildCachePruneRequest) -> ValidatorResult;
    fn validate_registry_garbage_collect(
        &self,
        req: &RegistryGarbageCollectRequest,
    ) -> ValidatorResult;
    fn validate_network_create(&self, req: &NetworkCreateRequest) -> ValidatorResult;
    fn validate_network_remove(&self, req: &NetworkRemoveRequest) -> ValidatorResult;
    fn validate_network_connect(&self, req: &NetworkConnectRequest) -> ValidatorResult;
    fn validate_network_disconnect(&self, req: &NetworkDisconnectRequest) -> ValidatorResult;
    fn validate_container_exec(&self, req: &ExecStart) -> ValidatorResult;
    fn validate_list_container_files(&self, req: &ListContainerFilesRequest) -> ValidatorResult;
    fn validate_read_container_file(&self, req: &ReadContainerFileRequest) -> ValidatorResult;
    fn validate_inspect_container_health(
        &self,
        req: &InspectContainerHealthRequest,
    ) -> ValidatorResult;
    fn validate_service_create(&self, req: &SwarmServiceSpec) -> ValidatorResult;
    fn validate_service_update_image(&self, req: &ServiceUpdateImageRequest) -> ValidatorResult;
    fn validate_service_scale(&self, req: &ServiceScaleRequest) -> ValidatorResult;
    fn validate_service_rollback(&self, req: &ServiceRollbackRequest) -> ValidatorResult;
    fn validate_service_remove(&self, req: &ServiceRemoveRequest) -> ValidatorResult;
    fn validate_list_service_tasks(&self, req: &ListServiceTasksRequest) -> ValidatorResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// PermissiveValidator — always allows everything (development / testing only)
// ─────────────────────────────────────────────────────────────────────────────

/// No-op validator used for development and integration tests.
///
/// **WARNING**: this must never be used in production. Replace with
/// `StrictValidator` when deploying.
#[allow(dead_code)]
pub struct PermissiveValidator;

impl Validator for PermissiveValidator {
    fn validate_container_create(&self, _req: &ContainerCreateRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_container_start(&self, _req: &ContainerStartRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_container_stop(&self, _req: &ContainerStopRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_container_remove(&self, _req: &ContainerRemoveRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_image_pull(&self, _req: &ImagePullRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_image_build(&self, _req: &ImageBuildRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_image_prune(&self, _req: &ImagePruneRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_image_push(&self, _req: &ImagePushRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_image_remove(&self, _req: &ImageRemoveRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_build_cache_prune(&self, _req: &BuildCachePruneRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_registry_garbage_collect(
        &self,
        _req: &RegistryGarbageCollectRequest,
    ) -> ValidatorResult {
        Ok(())
    }
    fn validate_network_create(&self, _req: &NetworkCreateRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_network_remove(&self, _req: &NetworkRemoveRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_network_connect(&self, _req: &NetworkConnectRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_network_disconnect(&self, _req: &NetworkDisconnectRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_container_exec(&self, _req: &ExecStart) -> ValidatorResult {
        Ok(())
    }
    fn validate_list_container_files(&self, _req: &ListContainerFilesRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_read_container_file(&self, _req: &ReadContainerFileRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_inspect_container_health(
        &self,
        _req: &InspectContainerHealthRequest,
    ) -> ValidatorResult {
        Ok(())
    }
    fn validate_service_create(&self, _req: &SwarmServiceSpec) -> ValidatorResult {
        Ok(())
    }
    fn validate_service_update_image(&self, _req: &ServiceUpdateImageRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_service_scale(&self, _req: &ServiceScaleRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_service_rollback(&self, _req: &ServiceRollbackRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_service_remove(&self, _req: &ServiceRemoveRequest) -> ValidatorResult {
        Ok(())
    }
    fn validate_list_service_tasks(&self, _req: &ListServiceTasksRequest) -> ValidatorResult {
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ValidatorConfig — deserialisable from TOML/JSON or env defaults
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration for `StrictValidator`.
///
/// Can be built from TOML/JSON or constructed programmatically.
/// All fields have sensible defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorConfig {
    /// Registries allowed for image pulls and container creation.
    /// Default: `["docker.io", "ghcr.io", "registry.ploydok.io"]`
    #[serde(default = "default_allowed_registries")]
    pub allowed_registries: Vec<String>,

    /// Root prefix allowed for host-side volume mounts.
    /// Default: `/var/lib/ploydok/volumes`
    #[serde(default = "default_volume_prefix")]
    pub volume_prefix: String,

    /// Root prefix allowed for app persistent bind mounts.
    /// Default: `/var/lib/ploydok/app-volumes`
    #[serde(default = "default_app_volume_prefix")]
    pub app_volume_prefix: String,

    /// Maximum fractional CPUs allowed in resource limits.
    /// Default: `4.0`
    #[serde(default = "default_max_cpu")]
    pub max_cpu: f64,

    /// Maximum memory in bytes allowed in resource limits.
    /// Default: `8 * 1024^3` (8 GiB)
    #[serde(default = "default_max_memory_bytes")]
    pub max_memory_bytes: i64,
}

fn default_allowed_registries() -> Vec<String> {
    vec![
        "docker.io".to_string(),
        "ghcr.io".to_string(),
        "registry.ploydok.io".to_string(),
    ]
}

fn default_volume_prefix() -> String {
    "/var/lib/ploydok/volumes".to_string()
}

fn default_app_volume_prefix() -> String {
    "/var/lib/ploydok/app-volumes".to_string()
}

fn default_max_cpu() -> f64 {
    4.0
}

fn default_max_memory_bytes() -> i64 {
    8 * 1024 * 1024 * 1024 // 8 GiB
}

impl Default for ValidatorConfig {
    fn default() -> Self {
        Self {
            allowed_registries: default_allowed_registries(),
            volume_prefix: default_volume_prefix(),
            app_volume_prefix: default_app_volume_prefix(),
            max_cpu: default_max_cpu(),
            max_memory_bytes: default_max_memory_bytes(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// StrictValidator — production allowlist enforcement
// ─────────────────────────────────────────────────────────────────────────────

/// Production validator enforcing the Ploydok allowlist policy.
///
/// Constructed via [`StrictValidator::new`] with a [`ValidatorConfig`].
/// All violations return a boxed [`Status`] with `permission_denied` or
/// `invalid_argument` codes and a JSON detail in the message.
pub struct StrictValidator {
    cfg: ValidatorConfig,
}

impl StrictValidator {
    pub fn new(cfg: ValidatorConfig) -> Self {
        Self { cfg }
    }

    /// Borrow the active configuration. Used by the boot logger so the operator
    /// sees the *loaded* config (e.g. with `127.0.0.1:5000` from
    /// `dev-validator.toml`) rather than `ValidatorConfig::default()`.
    pub fn config(&self) -> &ValidatorConfig {
        &self.cfg
    }

    /// Build from environment variable `PLOYDOK_VALIDATOR_CONFIG` (path to TOML/JSON file),
    /// or return the default config if not set.
    pub fn from_env() -> anyhow::Result<Self> {
        let cfg = if let Ok(path) = std::env::var("PLOYDOK_VALIDATOR_CONFIG") {
            let content = std::fs::read_to_string(&path)?;
            let ext = Path::new(&path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("json");
            if ext == "toml" {
                toml::from_str(&content)?
            } else {
                serde_json::from_str(&content)?
            }
        } else {
            ValidatorConfig::default()
        };
        Ok(Self::new(cfg))
    }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/// Build a denied `Status` with a JSON-encoded rule detail in the message.
fn deny(code: tonic::Code, rule: &str, detail: impl Serialize) -> Box<Status> {
    let detail_json = serde_json::to_string(&detail).unwrap_or_else(|_| "{}".to_string());
    let msg = format!("Requête refusée — règle: {rule} — {detail_json}");
    tracing::warn!(rule = rule, detail = %detail_json, "validator: accès refusé");
    Box::new(Status::new(code, msg))
}

/// Extract the registry from an image reference.
///
/// Rules (mirroring Docker client conventions):
/// - If reference contains a `/` and the part before the first `/` contains a
///   `.` or `:` or is `localhost`, it is the registry.
/// - Otherwise the registry is `docker.io`.
fn extract_registry(image: &str) -> &str {
    // Strip tag/digest for registry extraction.
    let without_tag = if let Some(at) = image.find('@') {
        &image[..at]
    } else {
        image
    };
    if let Some(slash) = without_tag.find('/') {
        let candidate = &without_tag[..slash];
        if candidate.contains('.') || candidate.contains(':') || candidate == "localhost" {
            return candidate;
        }
    }
    "docker.io"
}

/// Validate that a `host_path` is under one of the allowlisted prefixes without path traversal.
///
/// Returns `Ok(())` on success, or the violated path as `Err(String)`.
fn validate_host_path(host_path: &str, allowed_prefixes: &[&str]) -> Result<(), String> {
    // Reject null bytes and obvious traversal sequences before any canonicalisation.
    if host_path.contains('\0') || host_path.contains("..") {
        return Err(format!(
            "path traversal détecté dans host_path: {host_path}"
        ));
    }

    for prefix in allowed_prefixes {
        let normalized = prefix.trim_end_matches('/');
        if host_path.starts_with(&format!("{normalized}/")) || host_path == normalized {
            return Ok(());
        }
    }

    Err(format!(
        "host_path '{host_path}' hors des préfixes autorisés: {}",
        allowed_prefixes.join(", ")
    ))
}

/// Label carrying the service-specific volume root for Compose workloads.
///
/// The API owns this label. The agent still validates its shape and containment
/// because it is the last boundary before Docker receives a bind mount.
pub const MARKETPLACE_VOLUME_ROOT_LABEL: &str = "ploydok.volume_root";

fn normalize_absolute_path(candidate: &str) -> Result<PathBuf, String> {
    if candidate.is_empty() || candidate.contains('\0') {
        return Err("path must be a non-empty absolute path without NUL bytes".to_string());
    }

    let path = Path::new(candidate);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Normal(_) => normalized.push(component.as_os_str()),
            Component::Prefix(_) | Component::CurDir | Component::ParentDir => {
                return Err("path must not contain '.', '..', or a platform prefix".to_string())
            }
        }
    }

    // Do not accept aliases such as a trailing slash, duplicate separators, or
    // a path that only becomes safe after normalization.
    if normalized.as_os_str() != path.as_os_str() {
        return Err("path is not normalized".to_string());
    }
    Ok(normalized)
}

fn validate_strict_descendant(candidate: &str, root: &Path) -> Result<(), String> {
    let normalized = normalize_absolute_path(candidate)?;
    if normalized == root {
        return Err("path must be a strict descendant of the declared root".to_string());
    }
    if !normalized.starts_with(root) {
        return Err("path is outside the declared root".to_string());
    }
    Ok(())
}

fn path_is_under_prefix(candidate: &str, prefix: &str) -> bool {
    let normalized_prefix = prefix.trim_end_matches('/');
    candidate == normalized_prefix || candidate.starts_with(&format!("{normalized_prefix}/"))
}

fn declared_root_scope(labels: &HashMap<String, String>, name: &str) -> (bool, bool) {
    let kind = labels.get("ploydok.kind").map(String::as_str);
    let has_service_identity = labels
        .get("ploydok.service_id")
        .is_some_and(|service_id| !service_id.is_empty());
    let service_scoped = matches!(kind, Some("service"))
        || has_service_identity
        || name.starts_with("ploydok-svc-")
        || name.starts_with("ploydok-app-svc-");
    let requires_global_root = service_scoped
        || labels.contains_key(MARKETPLACE_VOLUME_ROOT_LABEL)
        || matches!(kind, Some("app" | "preview"))
        || name.starts_with("ploydok-app-");

    // The first flag requires a root for mounts below volume_prefix. The
    // second flag applies that root to every mount, including app volumes.
    (
        requires_global_root,
        service_scoped || labels.contains_key(MARKETPLACE_VOLUME_ROOT_LABEL),
    )
}

/// Validate bind mounts while preserving the broad legacy roots used by
/// ordinary apps, databases, and internal workloads.
fn validate_workload_mounts<'a>(
    labels: &HashMap<String, String>,
    name: &str,
    mounts: impl Iterator<Item = &'a str>,
    volume_prefix: &str,
    app_volume_prefix: &str,
) -> Result<(), String> {
    let (requires_global_root, strict_all_mounts) = declared_root_scope(labels, name);
    let declared_root = if requires_global_root {
        labels
            .get(MARKETPLACE_VOLUME_ROOT_LABEL)
            .map(|raw_root| {
                let root = normalize_absolute_path(raw_root)?;
                let normalized_volume_prefix =
                    normalize_absolute_path(volume_prefix.trim_end_matches('/'))
                        .map_err(|reason| format!("invalid configured volume prefix: {reason}"))?;
                let relative = root
                    .strip_prefix(&normalized_volume_prefix)
                    .map_err(|_| "declared root must be under volume_prefix".to_string())?;
                if relative.components().count() != 1 {
                    return Err(
                        "declared root must be one direct child of volume_prefix".to_string()
                    );
                }
                if let Some(service_id) = labels
                    .get("ploydok.service_id")
                    .filter(|service_id| !service_id.is_empty())
                {
                    let root_name = root
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default();
                    let docker_root_name = format!("ploydok-svc-{service_id}");
                    let swarm_root_prefix = format!("tmp-svc-{service_id}");
                    let matches_swarm_root = root_name == swarm_root_prefix
                        || root_name
                            .strip_prefix(&swarm_root_prefix)
                            .is_some_and(|suffix| suffix.starts_with('-'));
                    if root_name != docker_root_name && !matches_swarm_root {
                        return Err(
                            "declared root does not match the marketplace service identity"
                                .to_string(),
                        );
                    }
                }
                Ok(root)
            })
            .transpose()?
    } else {
        None
    };

    for host_path in mounts {
        validate_host_path(host_path, &[volume_prefix, app_volume_prefix])?;

        if strict_all_mounts {
            let root = declared_root.as_deref().ok_or_else(|| {
                format!("declared-root workload mount requires {MARKETPLACE_VOLUME_ROOT_LABEL}")
            })?;
            validate_strict_descendant(host_path, root)?;
        } else if requires_global_root && path_is_under_prefix(host_path, volume_prefix) {
            let root = declared_root.as_deref().ok_or_else(|| {
                format!("declared-root workload mount requires {MARKETPLACE_VOLUME_ROOT_LABEL}")
            })?;
            validate_strict_descendant(host_path, root)?;
        } else if path_is_under_prefix(host_path, app_volume_prefix) {
            // App volumes are a separate ownership namespace and retain their
            // existing semantics for every non-marketplace workload kind.
            continue;
        }
    }
    Ok(())
}

const MANAGED_IMAGE_REGISTRIES: &[&str] = &["registry:5000", "127.0.0.1:5000", "localhost:5000"];
const MIN_BUILD_CACHE_KEEP_BYTES: i64 = 1024 * 1024 * 1024;
const MAX_BUILD_CACHE_KEEP_BYTES: i64 = 1024 * 1024 * 1024 * 1024;
const MIN_BUILD_CACHE_AGE_SECONDS: i64 = 60 * 60;
const MAX_BUILD_CACHE_AGE_SECONDS: i64 = 365 * 24 * 60 * 60;
const DEFAULT_REGISTRY_CONFIG: &str = "/etc/docker/registry/config.yml";

fn image_repository(image: &str) -> Option<(&str, &str)> {
    let registry = extract_registry(image);
    let slash = image.find('/')?;
    let repository_with_ref = &image[slash + 1..];
    let repository_without_digest = repository_with_ref
        .split_once('@')
        .map_or(repository_with_ref, |(repository, _)| repository);
    let repository = repository_without_digest
        .rsplit_once(':')
        .map_or(repository_without_digest, |(repository, _)| repository);
    Some((registry, repository))
}

pub(crate) fn validate_image_repository_remove(image: &str) -> ValidatorResult {
    validate_managed_image(image)?;
    let repository = image.split_once('/').map(|(_, repository)| repository);
    if repository.is_none_or(|repository| repository.contains([':', '@'])) {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "image_remove_repository_only",
            serde_json::json!({ "image": image }),
        ));
    }
    Ok(())
}

fn validate_managed_image(image: &str) -> ValidatorResult {
    let Some((registry, repository)) = image_repository(image) else {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "managed_image_reference",
            serde_json::json!({ "image": image }),
        ));
    };
    let valid_repository = repository
        .strip_prefix("app-")
        .or_else(|| repository.strip_prefix("preview-app-"))
        .is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix.len() <= 200
                && suffix.chars().all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
                })
        });
    if !MANAGED_IMAGE_REGISTRIES.contains(&registry) || !valid_repository {
        return Err(deny(
            tonic::Code::PermissionDenied,
            "managed_image_only",
            serde_json::json!({
                "image": image,
                "registry": registry,
                "repository": repository,
            }),
        ));
    }
    Ok(())
}

fn validate_build_cache_bounds(req: &BuildCachePruneRequest) -> ValidatorResult {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| {
            deny(
                tonic::Code::Internal,
                "system_clock_before_epoch",
                serde_json::json!({}),
            )
        })?
        .as_secs() as i64;
    let age_seconds = now.saturating_sub(req.until_unix);
    if req.until_unix <= 0
        || req.until_unix > now
        || !(MIN_BUILD_CACHE_AGE_SECONDS..=MAX_BUILD_CACHE_AGE_SECONDS).contains(&age_seconds)
    {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "build_cache_until_bounds",
            serde_json::json!({
                "until_unix": req.until_unix,
                "min_age_seconds": MIN_BUILD_CACHE_AGE_SECONDS,
                "max_age_seconds": MAX_BUILD_CACHE_AGE_SECONDS,
            }),
        ));
    }
    if !(MIN_BUILD_CACHE_KEEP_BYTES..=MAX_BUILD_CACHE_KEEP_BYTES).contains(&req.keep_storage_bytes)
    {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "build_cache_keep_storage_bounds",
            serde_json::json!({
                "keep_storage_bytes": req.keep_storage_bytes,
                "min": MIN_BUILD_CACHE_KEEP_BYTES,
                "max": MAX_BUILD_CACHE_KEEP_BYTES,
            }),
        ));
    }
    Ok(())
}

fn validate_image_prune_bounds(req: &ImagePruneRequest) -> ValidatorResult {
    if req.all {
        return Err(deny(
            tonic::Code::PermissionDenied,
            "image_prune_global_forbidden",
            serde_json::json!({ "all": true }),
        ));
    }
    if !req.keep_repo_tags.is_empty() {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "image_prune_keep_tags_without_global_mode",
            serde_json::json!({ "keep_repo_tags": &req.keep_repo_tags }),
        ));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| {
            deny(
                tonic::Code::Internal,
                "system_clock_before_epoch",
                serde_json::json!({}),
            )
        })?
        .as_secs() as i64;
    let age_seconds = now.saturating_sub(req.until_unix);
    if req.until_unix <= 0
        || req.until_unix > now
        || !(MIN_BUILD_CACHE_AGE_SECONDS..=MAX_BUILD_CACHE_AGE_SECONDS).contains(&age_seconds)
    {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "image_prune_until_bounds",
            serde_json::json!({
                "until_unix": req.until_unix,
                "min_age_seconds": MIN_BUILD_CACHE_AGE_SECONDS,
                "max_age_seconds": MAX_BUILD_CACHE_AGE_SECONDS,
            }),
        ));
    }
    Ok(())
}

fn validate_registry_config_path(config_path: &str) -> ValidatorResult {
    let candidate = if config_path.is_empty() {
        DEFAULT_REGISTRY_CONFIG
    } else {
        config_path
    };
    if candidate.contains('\0')
        || candidate.len() > 4096
        || candidate
            .split('/')
            .any(|component| component == "." || component == "..")
    {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "registry_config_path",
            serde_json::json!({ "config_path": candidate }),
        ));
    }

    let path = Path::new(candidate);
    if !path.is_absolute() {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "registry_config_path_absolute",
            serde_json::json!({ "config_path": candidate }),
        ));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Normal(_) => normalized.push(component.as_os_str()),
            Component::Prefix(_) | Component::CurDir | Component::ParentDir => {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "registry_config_path_normalized",
                    serde_json::json!({ "config_path": candidate }),
                ));
            }
        }
    }
    let allowed_root = Path::new("/etc/docker/registry");
    if normalized != path || !normalized.starts_with(allowed_root) || normalized == allowed_root {
        return Err(deny(
            tonic::Code::PermissionDenied,
            "registry_config_path_scope",
            serde_json::json!({ "config_path": candidate }),
        ));
    }
    Ok(())
}

// ─── Validator impl ──────────────────────────────────────────────────────────

impl Validator for StrictValidator {
    fn validate_container_create(&self, req: &ContainerCreateRequest) -> ValidatorResult {
        // 1. Name: must match ^ploydok-[a-z0-9][a-z0-9-]{0,62}$
        {
            let name_re =
                regex_lite::Regex::new(r"^ploydok-[a-z0-9][a-z0-9-]{0,62}$").expect("static regex");
            if !name_re.is_match(&req.name) {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "container_name_prefix",
                    serde_json::json!({
                        "name": &req.name,
                        "expected": "^ploydok-[a-z0-9][a-z0-9-]{0,62}$"
                    }),
                ));
            }
        }

        // 2. Image registry allowlist.
        {
            let registry = extract_registry(&req.image);
            if !self.cfg.allowed_registries.iter().any(|r| r == registry) {
                return Err(deny(
                    tonic::Code::PermissionDenied,
                    "image_registry_allowlist",
                    serde_json::json!({
                        "image": &req.image,
                        "registry": registry,
                        "allowed": &self.cfg.allowed_registries
                    }),
                ));
            }
        }

        // 3. Volume host paths: under the allowlisted Ploydok roots, with a
        // strict declared root for Compose and marketplace workloads.
        if let Err(reason) = validate_workload_mounts(
            &req.labels,
            &req.name,
            req.volumes.iter().map(|volume| volume.host_path.as_str()),
            &self.cfg.volume_prefix,
            &self.cfg.app_volume_prefix,
        ) {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "volume_host_path",
                serde_json::json!({ "reason": reason }),
            ));
        }

        // 4. Labels: must contain non-empty ploydok.app_id and ploydok.owner_id.
        for key in &["ploydok.app_id", "ploydok.owner_id"] {
            match req.labels.get(*key) {
                Some(v) if !v.is_empty() => {}
                _ => {
                    return Err(deny(
                        tonic::Code::InvalidArgument,
                        "required_labels",
                        serde_json::json!({ "missing_label": key }),
                    ));
                }
            }
        }

        // Explicit host bindings must be literal IPs. The API rejects
        // wildcard bindings for marketplace services; the agent repeats that
        // invariant because it is the final Docker boundary.
        for port in &req.ports {
            validate_host_ip(&port.host_ip)?;
        }

        // 5. Healthcheck: if set, only Docker-supported modes and non-negative timings.
        if let Some(healthcheck) = &req.healthcheck {
            if healthcheck.test.is_empty() {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "healthcheck_test_empty",
                    serde_json::json!({ "healthcheck": "test array must not be empty when provided" }),
                ));
            }

            crate::service::http_probe::validate(&healthcheck.test).map_err(Box::new)?;
            let mode = healthcheck.test[0].as_str();
            if !["CMD", "CMD-SHELL", "NONE", "PLOYDOK-HTTP"].contains(&mode) {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "healthcheck_mode_invalid",
                    serde_json::json!({
                        "mode": mode,
                        "allowed": ["CMD", "CMD-SHELL", "NONE"]
                    }),
                ));
            }

            for (field, value) in [
                ("interval_seconds", healthcheck.interval_seconds),
                ("timeout_seconds", healthcheck.timeout_seconds),
                ("start_period_seconds", healthcheck.start_period_seconds),
            ] {
                if value < 0 {
                    return Err(deny(
                        tonic::Code::InvalidArgument,
                        "healthcheck_negative_duration",
                        serde_json::json!({ "field": field, "value": value }),
                    ));
                }
            }
        }

        // 6. Network(s): empty or matching ploydok-*; never "host".
        // Validate both the legacy single-string `network` field AND the new
        // repeated `networks` field (sprint-3bis multi-network support).
        let mut net_candidates: Vec<&str> = Vec::new();
        if !req.network.is_empty() {
            net_candidates.push(&req.network);
        }
        for n in &req.networks {
            if !n.is_empty() {
                net_candidates.push(n);
            }
        }
        for n in &net_candidates {
            validate_workload_network_name(n)?;
        }

        // 7. User: must not be root/0 if specified.
        if !req.user.is_empty()
            && (req.user == "root" || req.user == "0" || req.user.starts_with("0:"))
        {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "user_root_forbidden",
                serde_json::json!({ "user": &req.user }),
            ));
        }

        // 8. Resource limits: cpu ≤ max_cpu, memory ≤ max_memory_bytes.
        if let Some(limits) = &req.resource_limits {
            if limits.cpu > self.cfg.max_cpu && limits.cpu > 0.0 {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "resource_cpu_limit",
                    serde_json::json!({
                        "cpu": limits.cpu,
                        "max_cpu": self.cfg.max_cpu
                    }),
                ));
            }
            if limits.memory_bytes > self.cfg.max_memory_bytes && limits.memory_bytes > 0 {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "resource_memory_limit",
                    serde_json::json!({
                        "memory_bytes": limits.memory_bytes,
                        "max_memory_bytes": self.cfg.max_memory_bytes
                    }),
                ));
            }
        }

        Ok(())
    }

    fn validate_container_start(&self, req: &ContainerStartRequest) -> ValidatorResult {
        // Containers are only created through our flow (which enforces the ploydok- prefix),
        // so for start/stop/remove by id we accept the request — the label check is done
        // at create time. We still enforce that the id/name is non-empty.
        if req.container_id.is_empty() {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "container_id_empty",
                serde_json::json!({ "container_id": "" }),
            ));
        }
        // If the caller passes a name (not a sha256 id), enforce ploydok- prefix.
        if !req.container_id.starts_with("sha256:")
            && !looks_like_short_id(&req.container_id)
            && !req.container_id.starts_with("ploydok-")
        {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "container_name_prefix",
                serde_json::json!({ "container_id": &req.container_id }),
            ));
        }
        Ok(())
    }

    fn validate_container_stop(&self, req: &ContainerStopRequest) -> ValidatorResult {
        if req.container_id.is_empty() {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "container_id_empty",
                serde_json::json!({ "container_id": "" }),
            ));
        }
        if !req.container_id.starts_with("sha256:")
            && !looks_like_short_id(&req.container_id)
            && !req.container_id.starts_with("ploydok-")
        {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "container_name_prefix",
                serde_json::json!({ "container_id": &req.container_id }),
            ));
        }
        Ok(())
    }

    fn validate_container_remove(&self, req: &ContainerRemoveRequest) -> ValidatorResult {
        if req.container_id.is_empty() {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "container_id_empty",
                serde_json::json!({ "container_id": "" }),
            ));
        }
        if !req.container_id.starts_with("sha256:")
            && !looks_like_short_id(&req.container_id)
            && !req.container_id.starts_with("ploydok-")
        {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "container_name_prefix",
                serde_json::json!({ "container_id": &req.container_id }),
            ));
        }
        Ok(())
    }

    fn validate_image_pull(&self, req: &ImagePullRequest) -> ValidatorResult {
        let registry = extract_registry(&req.image);
        if !self.cfg.allowed_registries.iter().any(|r| r == registry) {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "image_registry_allowlist",
                serde_json::json!({
                    "image": &req.image,
                    "registry": registry,
                    "allowed": &self.cfg.allowed_registries
                }),
            ));
        }
        Ok(())
    }

    fn validate_image_build(&self, req: &ImageBuildRequest) -> ValidatorResult {
        // Tag must start with ploydok-.
        if !req.tag.starts_with("ploydok-") {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "image_build_tag_prefix",
                serde_json::json!({ "tag": &req.tag, "expected_prefix": "ploydok-" }),
            ));
        }
        Ok(())
    }

    fn validate_image_prune(&self, req: &ImagePruneRequest) -> ValidatorResult {
        validate_image_prune_bounds(req)
    }

    fn validate_image_push(&self, req: &ImagePushRequest) -> ValidatorResult {
        validate_managed_image(&req.image)
    }

    fn validate_image_remove(&self, req: &ImageRemoveRequest) -> ValidatorResult {
        if req.all_tags {
            validate_image_repository_remove(&req.image)?;
        }
        validate_managed_image(&req.image)
    }

    fn validate_build_cache_prune(&self, req: &BuildCachePruneRequest) -> ValidatorResult {
        validate_build_cache_bounds(req)
    }

    fn validate_registry_garbage_collect(
        &self,
        req: &RegistryGarbageCollectRequest,
    ) -> ValidatorResult {
        validate_registry_config_path(&req.config_path)
    }

    fn validate_network_create(&self, req: &NetworkCreateRequest) -> ValidatorResult {
        // Name must start with ploydok-.
        if !req.name.starts_with("ploydok-") {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "network_name_prefix",
                serde_json::json!({ "name": &req.name, "expected_prefix": "ploydok-" }),
            ));
        }
        // Driver: bridge for legacy runtime, overlay for Swarm app runtime.
        let driver = if req.driver.is_empty() {
            "bridge"
        } else {
            &req.driver
        };
        if !["bridge", "overlay"].contains(&driver) {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "network_driver_forbidden",
                serde_json::json!({ "driver": driver, "allowed": ["bridge", "overlay"] }),
            ));
        }
        if driver == "overlay" && !req.attachable {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "overlay_network_must_be_attachable",
                serde_json::json!({ "name": &req.name }),
            ));
        }
        Ok(())
    }

    fn validate_network_remove(&self, req: &NetworkRemoveRequest) -> ValidatorResult {
        if req.network_id.is_empty() {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "network_id_empty",
                serde_json::json!({ "network_id": "" }),
            ));
        }
        // If the caller passes a name (not an opaque id), enforce ploydok- prefix.
        if !looks_like_network_id(&req.network_id) && !req.network_id.starts_with("ploydok-") {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "network_name_prefix",
                serde_json::json!({ "network_id": &req.network_id }),
            ));
        }
        Ok(())
    }

    fn validate_network_connect(&self, req: &NetworkConnectRequest) -> ValidatorResult {
        if req.network_id.is_empty() {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "network_id_empty",
                serde_json::json!({ "network_id": "" }),
            ));
        }
        if !looks_like_network_id(&req.network_id) && !req.network_id.starts_with("ploydok-") {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "network_name_prefix",
                serde_json::json!({ "network_id": &req.network_id, "expected_prefix": "ploydok-" }),
            ));
        }
        validate_container_id(&req.container_id)?;
        Ok(())
    }

    fn validate_network_disconnect(&self, req: &NetworkDisconnectRequest) -> ValidatorResult {
        if req.network_id.is_empty() {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "network_id_empty",
                serde_json::json!({ "network_id": "" }),
            ));
        }
        if !looks_like_network_id(&req.network_id) && !req.network_id.starts_with("ploydok-") {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "network_name_prefix",
                serde_json::json!({ "network_id": &req.network_id, "expected_prefix": "ploydok-" }),
            ));
        }
        validate_container_id(&req.container_id)?;
        Ok(())
    }

    fn validate_container_exec(&self, req: &ExecStart) -> ValidatorResult {
        // 1. container_id: non-empty; if a name (not sha256/short-id), must start with ploydok-.
        if req.container_id.is_empty() {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "container_id_empty",
                serde_json::json!({ "container_id": "" }),
            ));
        }
        if !req.container_id.starts_with("sha256:")
            && !looks_like_short_id(&req.container_id)
            && !req.container_id.starts_with("ploydok-")
        {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "container_name_prefix",
                serde_json::json!({ "container_id": &req.container_id }),
            ));
        }

        // 2. cmd: at least one element; cmd[0] must be an allowed shell binary.
        if req.cmd.is_empty() {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "exec_cmd_empty",
                serde_json::json!({ "cmd": serde_json::Value::Array(vec![]) }),
            ));
        }
        const ALLOWED_SHELLS: &[&str] = &["/bin/sh", "/bin/bash", "sh", "bash"];
        if !ALLOWED_SHELLS.contains(&req.cmd[0].as_str()) {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "exec_cmd_not_allowed",
                serde_json::json!({
                    "cmd0": &req.cmd[0],
                    "allowed": ALLOWED_SHELLS
                }),
            ));
        }

        // 3. user: max 32 chars, alphanumeric + ":" (uid:gid or name).
        if !req.user.is_empty() {
            if req.user.len() > 32 {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "exec_user_too_long",
                    serde_json::json!({ "user": &req.user, "max_len": 32 }),
                ));
            }
            if !req.user.chars().all(|c| c.is_alphanumeric() || c == ':') {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "exec_user_invalid_chars",
                    serde_json::json!({
                        "user": &req.user,
                        "allowed_chars": "alphanumeric and ':'"
                    }),
                ));
            }
        }

        Ok(())
    }

    fn validate_list_container_files(&self, req: &ListContainerFilesRequest) -> ValidatorResult {
        validate_container_id(&req.container_id)?;
        validate_browse_path(&req.path)?;
        Ok(())
    }

    fn validate_read_container_file(&self, req: &ReadContainerFileRequest) -> ValidatorResult {
        validate_container_id(&req.container_id)?;
        validate_browse_path(&req.path)?;
        Ok(())
    }

    fn validate_inspect_container_health(
        &self,
        req: &InspectContainerHealthRequest,
    ) -> ValidatorResult {
        validate_container_id(&req.container_id)?;
        Ok(())
    }

    fn validate_service_create(&self, req: &SwarmServiceSpec) -> ValidatorResult {
        validate_service_name(&req.name)?;
        if let Some(hc) = &req.healthcheck {
            crate::service::http_probe::validate(&hc.test).map_err(Box::new)?;
        }
        if !["", "none", "on-failure", "any"].contains(&req.restart_condition.as_str()) {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "restart_condition",
                serde_json::json!({
                    "restart_condition": &req.restart_condition,
                    "allowed": ["", "none", "on-failure", "any"]
                }),
            ));
        }
        let registry = extract_registry(&req.image);
        if !self.cfg.allowed_registries.iter().any(|r| r == registry) {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "image_registry_allowlist",
                serde_json::json!({
                    "image": &req.image,
                    "registry": registry,
                    "allowed": &self.cfg.allowed_registries
                }),
            ));
        }
        for network in &req.networks {
            validate_workload_network_name(network)?;
        }
        if let Err(reason) = validate_workload_mounts(
            &req.labels,
            &req.name,
            req.mounts.iter().map(|mount| mount.host_path.as_str()),
            &self.cfg.volume_prefix,
            &self.cfg.app_volume_prefix,
        ) {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "volume_host_path",
                serde_json::json!({ "reason": reason }),
            ));
        }
        for key in &["ploydok.app_id", "ploydok.owner_id"] {
            match req.labels.get(*key) {
                Some(v) if !v.is_empty() => {}
                _ => {
                    return Err(deny(
                        tonic::Code::InvalidArgument,
                        "required_labels",
                        serde_json::json!({ "missing_label": key }),
                    ));
                }
            }
        }
        if let Some(limits) = &req.resource_limits {
            if limits.cpu > self.cfg.max_cpu && limits.cpu > 0.0 {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "resource_cpu_limit",
                    serde_json::json!({ "cpu": limits.cpu, "max_cpu": self.cfg.max_cpu }),
                ));
            }
            if limits.memory_bytes > self.cfg.max_memory_bytes && limits.memory_bytes > 0 {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "resource_memory_limit",
                    serde_json::json!({
                        "memory_bytes": limits.memory_bytes,
                        "max_memory_bytes": self.cfg.max_memory_bytes
                    }),
                ));
            }
        }
        Ok(())
    }

    fn validate_service_update_image(&self, req: &ServiceUpdateImageRequest) -> ValidatorResult {
        validate_service_name(&req.service_name)?;
        if let Some(spec) = req.spec.as_ref() {
            self.validate_service_create(spec)?;
            if spec.name != req.service_name {
                return Err(deny(
                    tonic::Code::InvalidArgument,
                    "service_name_mismatch",
                    serde_json::json!({
                        "service_name": &req.service_name,
                        "spec_name": &spec.name
                    }),
                ));
            }
        }
        let image = req
            .spec
            .as_ref()
            .map(|spec| spec.image.as_str())
            .unwrap_or(req.image.as_str());
        let registry = extract_registry(image);
        if !self.cfg.allowed_registries.iter().any(|r| r == registry) {
            return Err(deny(
                tonic::Code::PermissionDenied,
                "image_registry_allowlist",
                serde_json::json!({ "image": image, "registry": registry }),
            ));
        }
        Ok(())
    }

    fn validate_service_scale(&self, req: &ServiceScaleRequest) -> ValidatorResult {
        validate_service_name(&req.service_name)
    }

    fn validate_service_rollback(&self, req: &ServiceRollbackRequest) -> ValidatorResult {
        validate_service_name(&req.service_name)
    }

    fn validate_service_remove(&self, req: &ServiceRemoveRequest) -> ValidatorResult {
        validate_service_name(&req.service_name)
    }

    fn validate_list_service_tasks(&self, req: &ListServiceTasksRequest) -> ValidatorResult {
        validate_service_name(&req.service_name)
    }
}

fn validate_service_name(name: &str) -> ValidatorResult {
    let name_re =
        regex_lite::Regex::new(r"^ploydok-app-[a-z0-9][a-z0-9-]{0,90}$").expect("static regex");
    if !name_re.is_match(name) {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "service_name_prefix",
            serde_json::json!({ "name": name, "expected": "^ploydok-app-..." }),
        ));
    }
    Ok(())
}

fn validate_network_name(network: &str) -> ValidatorResult {
    if network.is_empty() || !network.starts_with("ploydok-") {
        return Err(deny(
            tonic::Code::PermissionDenied,
            "network_prefix",
            serde_json::json!({ "network": network, "expected_prefix": "ploydok-" }),
        ));
    }
    Ok(())
}

pub fn validate_workload_network_name(network: &str) -> ValidatorResult {
    if network == "host" {
        return Err(deny(
            tonic::Code::PermissionDenied,
            "network_host_forbidden",
            serde_json::json!({ "network": network }),
        ));
    }
    if matches!(
        network,
        "ploydok-management" | "ploydok-build" | "ploydok-monitoring" | "ploydok-alerting"
    ) {
        return Err(deny(
            tonic::Code::PermissionDenied,
            "network_control_plane_forbidden",
            serde_json::json!({ "network": network }),
        ));
    }
    validate_network_name(network)
}

fn validate_container_id(container_id: &str) -> ValidatorResult {
    if container_id.is_empty() {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "container_id_empty",
            serde_json::json!({ "container_id": "" }),
        ));
    }
    if !container_id.starts_with("sha256:")
        && !looks_like_short_id(container_id)
        && !container_id.starts_with("ploydok-")
    {
        return Err(deny(
            tonic::Code::PermissionDenied,
            "container_name_prefix",
            serde_json::json!({ "container_id": container_id }),
        ));
    }
    Ok(())
}

fn validate_host_ip(host_ip: &str) -> ValidatorResult {
    if host_ip.is_empty() {
        return Ok(());
    }
    let parsed = host_ip.parse::<IpAddr>().map_err(|_| {
        deny(
            tonic::Code::InvalidArgument,
            "host_ip_literal",
            serde_json::json!({ "host_ip": host_ip, "expected": "IPv4 or IPv6 literal" }),
        )
    })?;
    if parsed.is_unspecified() {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "host_ip_wildcard_forbidden",
            serde_json::json!({ "host_ip": host_ip }),
        ));
    }
    Ok(())
}

fn validate_browse_path(path: &str) -> ValidatorResult {
    if !path.starts_with('/') {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "path_not_absolute",
            serde_json::json!({ "path": path }),
        ));
    }
    if path.contains('\0') {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "path_contains_nul",
            serde_json::json!({}),
        ));
    }
    for segment in path.split('/') {
        if segment == ".." {
            return Err(deny(
                tonic::Code::InvalidArgument,
                "path_contains_dotdot",
                serde_json::json!({ "path": path }),
            ));
        }
    }
    if path.len() > 4096 {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "path_too_long",
            serde_json::json!({ "max_len": 4096 }),
        ));
    }
    Ok(())
}

/// Validate an `age` recipient string — used by `dump_database` when encryption
/// is requested. Restricts to the X25519 `age1<bech32>` format and rejects
/// anything else.
///
/// **Why strict**: the recipient is interpolated into a `sh -c "... | age -r
/// <recipient>"` command line inside the container. Any shell metacharacter
/// (`$`, `` ` ``, `;`, ` `, `\\`, `&`, `|`, `<`, `>`, etc.) would let an
/// attacker break out of the `age -r` argument and execute arbitrary commands.
/// We therefore whitelist only `[a-z0-9]` after the `age1` prefix — this
/// excludes `ssh-rsa`/`ssh-ed25519` recipients (which legally contain spaces
/// and slashes) but keeps the pipeline injection-safe.
pub fn validate_age_recipient(recipient: &str) -> ValidatorResult {
    if !recipient.starts_with("age1") {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "age_recipient_format",
            serde_json::json!({ "expected_prefix": "age1" }),
        ));
    }
    // Bech32-encoded X25519 recipients are 62 chars total (`age1` + 58 chars).
    // Allow a small margin on each side to absorb future format changes.
    if recipient.len() < 60 || recipient.len() > 100 {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "age_recipient_length",
            serde_json::json!({
                "len": recipient.len(),
                "min": 60,
                "max": 100,
            }),
        ));
    }
    let body = &recipient[4..];
    if !body
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(deny(
            tonic::Code::InvalidArgument,
            "age_recipient_chars",
            serde_json::json!({ "allowed": "a-z 0-9" }),
        ));
    }
    Ok(())
}

// ─── ID heuristics ────────────────────────────────────────────────────────────

/// Returns true if `s` looks like a Docker short container id (12 hex chars)
/// or a full 64-char sha256 id (without the `sha256:` prefix).
fn looks_like_short_id(s: &str) -> bool {
    let len = s.len();
    (len == 12 || len == 64) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Returns true if `s` looks like a Docker network id (64 hex chars).
fn looks_like_network_id(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::validate_host_ip;

    #[test]
    fn host_ip_accepts_ipv4_and_ipv6_literals() {
        assert!(validate_host_ip("127.0.0.1").is_ok());
        assert!(validate_host_ip("::1").is_ok());
        assert!(validate_host_ip("10.0.0.10").is_ok());
    }

    #[test]
    fn host_ip_rejects_names_and_wildcards() {
        assert!(validate_host_ip("localhost").is_err());
        assert!(validate_host_ip("0.0.0.0").is_err());
        assert!(validate_host_ip("::").is_err());
    }

    #[test]
    fn empty_host_ip_keeps_legacy_requests_valid() {
        assert!(validate_host_ip("").is_ok());
    }
}
