// SPDX-License-Identifier: AGPL-3.0-only
//
// Allowlist tests — 10 tentatives d'actions interdites → 10 refus.
//
// Tests unitaires sur StrictValidator directement (pas de bollard nécessaire).

use ploydok_agent::validator::{
    validate_workload_network_name, StrictValidator, Validator, ValidatorConfig,
};
use ploydok_proto::agent::{
    BuildCachePruneRequest, ContainerCreateRequest, HealthcheckConfig, ImageBuildRequest,
    ImagePruneRequest, ImagePullRequest, ImagePushRequest, ImageRemoveRequest,
    NetworkCreateRequest, RegistryGarbageCollectRequest, ResourceLimits, ServiceUpdateImageRequest,
    SwarmServiceMount, SwarmServiceSpec, VolumeMount,
};
use tonic::Code;

/// Build a valid ContainerCreateRequest baseline (all rules satisfied).
fn valid_create() -> ContainerCreateRequest {
    ContainerCreateRequest {
        name: "ploydok-my-app".to_string(),
        image: "nginx:alpine".to_string(),
        env: Default::default(),
        labels: {
            let mut m = std::collections::HashMap::new();
            m.insert("ploydok.app_id".to_string(), "app-123".to_string());
            m.insert("ploydok.owner_id".to_string(), "owner-456".to_string());
            m
        },
        network: "ploydok-net".to_string(),
        volumes: vec![],
        ports: vec![],
        restart_policy: String::new(),
        resource_limits: None,
        command: vec![],
        user: String::new(),
        networks: vec![],
        healthcheck: None,
    }
}

fn make_validator() -> StrictValidator {
    StrictValidator::new(ValidatorConfig::default())
}

#[test]
fn managed_http_probes_validate_the_same_arguments_for_containers_and_swarm() {
    let validator = make_validator();
    for path in ["/ready path", "/\r\nInjected: header"] {
        let test = vec!["PLOYDOK-HTTP".into(), "80".into(), path.into()];
        let mut container = valid_create();
        container.healthcheck = Some(HealthcheckConfig {
            test: test.clone(),
            ..Default::default()
        });
        let mut service = valid_swarm_service();
        service.healthcheck = Some(ploydok_proto::agent::SwarmServiceHealthcheck {
            test,
            ..Default::default()
        });
        assert_eq!(
            validator.validate_container_create(&container).is_ok(),
            path == "/ready path"
        );
        assert_eq!(
            validator.validate_service_create(&service).is_ok(),
            path == "/ready path"
        );
    }
}

fn valid_swarm_service() -> SwarmServiceSpec {
    SwarmServiceSpec {
        name: "ploydok-app-test".to_string(),
        image: "alpine:3.20".to_string(),
        labels: std::collections::HashMap::from([
            ("ploydok.app_id".to_string(), "app-123".to_string()),
            ("ploydok.owner_id".to_string(), "owner-456".to_string()),
        ]),
        networks: vec!["ploydok-net".to_string()],
        ..Default::default()
    }
}

fn marketplace_labels(root: &str) -> std::collections::HashMap<String, String> {
    std::collections::HashMap::from([
        ("ploydok.kind".to_string(), "service".to_string()),
        ("ploydok.service_id".to_string(), "service-123".to_string()),
        ("ploydok.app_id".to_string(), "service-123".to_string()),
        ("ploydok.owner_id".to_string(), "owner-456".to_string()),
        ("ploydok.volume_root".to_string(), root.to_string()),
    ])
}

fn valid_marketplace_create() -> ContainerCreateRequest {
    let root = "/var/lib/ploydok/volumes/ploydok-svc-service-123";
    let mut req = valid_create();
    req.name = "ploydok-svc-service-123-web".to_string();
    req.labels = marketplace_labels(root);
    req.volumes = vec![VolumeMount {
        host_path: format!("{root}/data"),
        container_path: "/data".to_string(),
        read_only: false,
    }];
    req
}

// ─── Test 1: name sans préfixe ploydok- ──────────────────────────────────────

#[test]
fn test_name_without_ploydok_prefix_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.name = "myapp-container".to_string();

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::InvalidArgument, "mauvais code pour name");
    assert!(
        err.message().contains("container_name_prefix"),
        "message doit mentionner la règle: {}",
        err.message()
    );
}

// ─── Test 2: registry non autorisé ───────────────────────────────────────────

#[test]
fn test_evil_registry_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.image = "evil-registry.com/attacker/image:latest".to_string();

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(
        err.message().contains("image_registry_allowlist"),
        "message doit mentionner image_registry_allowlist: {}",
        err.message()
    );
}

#[test]
fn test_invalid_swarm_restart_condition_is_denied() {
    let v = make_validator();
    let mut req = valid_swarm_service();
    req.restart_condition = "always".to_string();

    let err = v
        .validate_service_create(&req)
        .expect_err("unknown Swarm restart condition must be rejected");
    assert_eq!(err.code(), Code::InvalidArgument);
    assert!(
        err.message().contains("restart_condition"),
        "message must mention restart_condition: {}",
        err.message()
    );
}

// ─── Test 3: bind-mount hors /var/lib/ploydok/volumes ────────────────────────

#[test]
fn test_volume_outside_prefix_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.volumes = vec![VolumeMount {
        host_path: "/home/user/data".to_string(),
        container_path: "/data".to_string(),
        read_only: false,
    }];

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(
        err.message().contains("volume_host_path"),
        "message doit mentionner volume_host_path: {}",
        err.message()
    );
}

// ─── Test 4: path traversal ───────────────────────────────────────────────────

#[test]
fn test_path_traversal_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.volumes = vec![VolumeMount {
        host_path: "/var/lib/ploydok/volumes/../../etc".to_string(),
        container_path: "/etc".to_string(),
        read_only: false,
    }];

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(
        err.message().contains("volume_host_path"),
        "message doit mentionner volume_host_path (traversal): {}",
        err.message()
    );
}

#[test]
fn test_app_volume_prefix_is_allowed() {
    let v = make_validator();
    let mut req = valid_create();
    req.volumes = vec![VolumeMount {
        host_path: "/var/lib/ploydok/app-volumes/app-123/vol-456".to_string(),
        container_path: "/data".to_string(),
        read_only: false,
    }];

    let result = v.validate_container_create(&req);
    assert!(result.is_ok(), "app volume prefix should be allowed");
}

#[test]
fn marketplace_mount_must_be_a_strict_descendant_of_declared_root() {
    let v = make_validator();
    let mut req = valid_marketplace_create();
    req.volumes[0].host_path = "/var/lib/ploydok/volumes/ploydok-svc-service-123".to_string();

    let err = v
        .validate_container_create(&req)
        .expect_err("the service root itself must not be mounted");
    assert!(err.message().contains("volume_host_path"));
}

#[test]
fn marketplace_mount_cannot_use_a_sibling_or_normalization_alias() {
    let v = make_validator();
    for host_path in [
        "/var/lib/ploydok/volumes/ploydok-svc-service-123-other/data",
        "/var/lib/ploydok/volumes/ploydok-svc-service-123/../other",
        "/var/lib/ploydok/volumes/ploydok-svc-service-123/data/",
        "/var/lib/ploydok/volumes/ploydok-svc-service-123//data",
        "/var/lib/ploydok/volumes/ploydok-svc-service-123/./data",
    ] {
        let mut req = valid_marketplace_create();
        req.volumes[0].host_path = host_path.to_string();
        let err = v
            .validate_container_create(&req)
            .expect_err("mount must stay below the declared service root");
        assert!(err.message().contains("volume_host_path"));
    }
}

#[test]
fn marketplace_declared_root_rejects_global_root_aliases_and_identity_mismatch() {
    let v = make_validator();
    for root in [
        "/var/lib/ploydok/volumes",
        "/var/lib/ploydok/volumes/",
        "/var/lib/ploydok/volumes//",
        "/var/lib/ploydok/volumes/./",
        "/var/lib/ploydok/volumes/ploydok-svc-service-123/",
        "/var/lib/ploydok/volumes/ploydok-svc-other",
    ] {
        let mut req = valid_marketplace_create();
        req.labels
            .insert("ploydok.volume_root".to_string(), root.to_string());
        let err = v
            .validate_container_create(&req)
            .expect_err("declared root must be canonical, direct, and service-scoped");
        assert!(err.message().contains("volume_host_path"));
    }
}

#[test]
fn marketplace_mount_requires_a_declared_root_even_without_kind_label() {
    let v = make_validator();
    let mut req = valid_marketplace_create();
    req.labels.remove("ploydok.kind");
    req.labels.remove("ploydok.volume_root");

    let err = v
        .validate_container_create(&req)
        .expect_err("the generated marketplace name must not bypass root validation");
    assert!(err.message().contains("volume_host_path"));
}

#[test]
fn marketplace_mounts_cannot_escape_to_app_volume_prefix() {
    let v = make_validator();
    let mut req = valid_marketplace_create();
    req.volumes[0].host_path = "/var/lib/ploydok/app-volumes/service-123/data".to_string();

    let err = v
        .validate_container_create(&req)
        .expect_err("marketplace mounts must use their declared service root");
    assert!(err.message().contains("volume_host_path"));
}

#[test]
fn legacy_database_mount_remains_allowed() {
    let v = make_validator();
    let mut req = valid_create();
    req.name = "ploydok-db-service-123".to_string();
    req.labels
        .insert("ploydok.kind".to_string(), "database".to_string());
    req.volumes = vec![VolumeMount {
        host_path: "/var/lib/ploydok/volumes/database-service-123".to_string(),
        container_path: "/var/lib/database".to_string(),
        read_only: false,
    }];

    assert!(v.validate_container_create(&req).is_ok());
}

#[test]
fn declared_root_label_scopes_compose_app_mounts() {
    let v = make_validator();
    let root = "/var/lib/ploydok/volumes/compose-app-123";
    let mut req = valid_create();
    req.labels
        .insert("ploydok.volume_root".to_string(), root.to_string());
    req.volumes = vec![VolumeMount {
        host_path: format!("{root}/data"),
        container_path: "/data".to_string(),
        read_only: false,
    }];
    assert!(v.validate_container_create(&req).is_ok());

    req.volumes[0].host_path = "/var/lib/ploydok/volumes/compose-app-123-other/data".to_string();
    let err = v
        .validate_container_create(&req)
        .expect_err("Compose app mounts must stay in their declared root");
    assert!(err.message().contains("volume_host_path"));
}

#[test]
fn compose_app_global_mount_requires_the_protected_root_label() {
    let v = make_validator();
    let mut req = valid_create();
    req.name = "ploydok-app-compose-123-web".to_string();
    req.labels
        .insert("ploydok.kind".to_string(), "app".to_string());
    req.volumes = vec![VolumeMount {
        host_path: "/var/lib/ploydok/volumes/compose-app-123/data".to_string(),
        container_path: "/data".to_string(),
        read_only: false,
    }];

    let err = v
        .validate_container_create(&req)
        .expect_err("Compose app global mounts must declare their root");
    assert!(err.message().contains("volume_host_path"));

    req.volumes[0].host_path = "/var/lib/ploydok/app-volumes/app-123/vol-1".to_string();
    assert!(
        v.validate_container_create(&req).is_ok(),
        "ordinary app-volume mounts keep their legacy namespace"
    );
}

#[test]
fn swarm_create_and_update_share_marketplace_mount_containment() {
    let v = make_validator();
    let root = "/var/lib/ploydok/volumes/tmp-svc-service-123-slug";
    let mut req = valid_swarm_service();
    req.name = "ploydok-app-svc-service-123-slug-web".to_string();
    req.labels = marketplace_labels(root);
    req.mounts = vec![SwarmServiceMount {
        host_path: format!("{root}/data"),
        container_path: "/data".to_string(),
        read_only: false,
    }];
    assert!(v.validate_service_create(&req).is_ok());

    req.mounts[0].host_path = format!("{root}-other/data");
    let update = ServiceUpdateImageRequest {
        service_name: req.name.clone(),
        image: String::new(),
        spec: Some(req),
        ..Default::default()
    };
    let err = v
        .validate_service_update_image(&update)
        .expect_err("Swarm updates must validate replacement mounts too");
    assert!(err.message().contains("volume_host_path"));
}

// ─── Test 5: labels manquants ─────────────────────────────────────────────────

#[test]
fn test_missing_labels_are_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.labels.remove("ploydok.app_id");

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::InvalidArgument);
    assert!(
        err.message().contains("required_labels"),
        "message doit mentionner required_labels: {}",
        err.message()
    );
}

// ─── Test 6: network host ─────────────────────────────────────────────────────

#[test]
fn test_network_host_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.network = "host".to_string();

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(
        err.message().contains("network_host_forbidden"),
        "message doit mentionner network_host_forbidden: {}",
        err.message()
    );
}

// ─── Test 7: user root ────────────────────────────────────────────────────────

#[test]
fn test_user_root_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.user = "root".to_string();

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(
        err.message().contains("user_root_forbidden"),
        "message doit mentionner user_root_forbidden: {}",
        err.message()
    );
}

// ─── Test 8: cpu > 4 ──────────────────────────────────────────────────────────

#[test]
fn test_resource_cpu_over_limit_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.resource_limits = Some(ResourceLimits {
        cpu: 8.0,
        memory_bytes: 0,
        pids_limit: 0,
    });

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::InvalidArgument);
    assert!(
        err.message().contains("resource_cpu_limit"),
        "message doit mentionner resource_cpu_limit: {}",
        err.message()
    );
}

// ─── Test 9: image build tag sans ploydok- ────────────────────────────────────

#[test]
fn test_image_build_tag_without_prefix_is_denied() {
    let v = make_validator();
    let req = ImageBuildRequest {
        tag: "myapp:latest".to_string(),
        dockerfile: b"FROM scratch".to_vec(),
        context: Default::default(),
        build_args: Default::default(),
    };

    let err = v.validate_image_build(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(
        err.message().contains("image_build_tag_prefix"),
        "message doit mentionner image_build_tag_prefix: {}",
        err.message()
    );
}

// ─── Test 10: network create driver macvlan ───────────────────────────────────

#[test]
fn test_network_create_macvlan_is_denied() {
    let v = make_validator();
    let req = NetworkCreateRequest {
        name: "ploydok-net-macvlan".to_string(),
        driver: "macvlan".to_string(),
        labels: Default::default(),
        attachable: false,
    };

    let err = v.validate_network_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(
        err.message().contains("network_driver_forbidden"),
        "message doit mentionner network_driver_forbidden: {}",
        err.message()
    );
}

#[test]
fn test_invalid_healthcheck_mode_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.healthcheck = Some(HealthcheckConfig {
        test: vec!["RUN".to_string(), "echo ok".to_string()],
        interval_seconds: 5,
        timeout_seconds: 5,
        retries: 3,
        start_period_seconds: 0,
    });

    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::InvalidArgument);
    assert!(
        err.message().contains("healthcheck_mode_invalid"),
        "message doit mentionner healthcheck_mode_invalid: {}",
        err.message()
    );
}

// ─── Tests complémentaires : cas valides passent ──────────────────────────────

#[test]
fn test_valid_container_create_passes() {
    let v = make_validator();
    let mut req = valid_create();
    req.volumes = vec![VolumeMount {
        host_path: "/var/lib/ploydok/volumes/myapp/data".to_string(),
        container_path: "/data".to_string(),
        read_only: false,
    }];
    req.resource_limits = Some(ResourceLimits {
        cpu: 2.0,
        memory_bytes: 512 * 1024 * 1024, // 512 MiB
        pids_limit: 0,
    });
    assert!(v.validate_container_create(&req).is_ok());
}

#[test]
fn test_valid_image_pull_passes() {
    let v = make_validator();
    let req = ImagePullRequest {
        image: "ghcr.io/myorg/myimage:latest".to_string(),
        registry_auth: None,
    };
    assert!(v.validate_image_pull(&req).is_ok());
}

#[test]
fn test_valid_image_build_passes() {
    let v = make_validator();
    let req = ImageBuildRequest {
        tag: "ploydok-myapp:1.0".to_string(),
        dockerfile: b"FROM scratch".to_vec(),
        context: Default::default(),
        build_args: Default::default(),
    };
    assert!(v.validate_image_build(&req).is_ok());
}

#[test]
fn test_valid_network_create_bridge_passes() {
    let v = make_validator();
    let req = NetworkCreateRequest {
        name: "ploydok-app-net".to_string(),
        driver: "bridge".to_string(),
        labels: Default::default(),
        attachable: false,
    };
    assert!(v.validate_network_create(&req).is_ok());
}

#[test]
fn test_image_pull_evil_registry_denied() {
    let v = make_validator();
    let req = ImagePullRequest {
        image: "attacker.io/payload:latest".to_string(),
        registry_auth: None,
    };
    let err = v.validate_image_pull(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
}

#[test]
fn test_network_create_host_driver_denied() {
    let v = make_validator();
    let req = NetworkCreateRequest {
        name: "ploydok-hostnet".to_string(),
        driver: "host".to_string(),
        labels: Default::default(),
        attachable: false,
    };
    let err = v.validate_network_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(err.message().contains("network_driver_forbidden"));
}

#[test]
fn test_image_push_only_accepts_ploydok_managed_repositories() {
    let v = make_validator();
    let valid = ImagePushRequest {
        image: "127.0.0.1:5000/app-demo:build-1".to_string(),
        registry_auth: None,
    };
    assert!(v.validate_image_push(&valid).is_ok());

    let unrelated = ImagePushRequest {
        image: "127.0.0.1:5000/library/postgres:16".to_string(),
        registry_auth: None,
    };
    let err = v.validate_image_push(&unrelated).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(err.message().contains("managed_image_only"));
}

#[test]
fn test_image_prune_forbids_global_or_unbounded_cleanup() {
    let v = make_validator();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs() as i64;
    let valid = ImagePruneRequest {
        all: false,
        until_unix: now - 7 * 24 * 60 * 60,
        keep_repo_tags: vec![],
    };
    assert!(v.validate_image_prune(&valid).is_ok());

    for invalid in [
        ImagePruneRequest {
            all: true,
            ..valid.clone()
        },
        ImagePruneRequest {
            until_unix: 0,
            ..valid.clone()
        },
        ImagePruneRequest {
            keep_repo_tags: vec!["127.0.0.1:5000/app-demo:latest".to_string()],
            ..valid
        },
    ] {
        assert!(v.validate_image_prune(&invalid).is_err());
    }
}

#[test]
fn test_image_remove_rejects_non_ploydok_images() {
    let v = make_validator();
    let valid = ImageRemoveRequest {
        image: "registry:5000/preview-app-demo:abc123".to_string(),
        all_tags: false,
    };
    assert!(v.validate_image_remove(&valid).is_ok());

    for image in [
        "docker.io/library/postgres:16",
        "127.0.0.1:5000/postgres:16",
        "127.0.0.1:5000/app-../../postgres:16",
    ] {
        let err = v
            .validate_image_remove(&ImageRemoveRequest {
                image: image.to_string(),
                all_tags: false,
            })
            .unwrap_err();
        assert!(matches!(
            err.code(),
            Code::PermissionDenied | Code::InvalidArgument
        ));
    }
}

#[test]
fn test_image_repository_remove_requires_exact_managed_repository() {
    let v = make_validator();
    for image in ["127.0.0.1:5000/app-demo", "registry:5000/preview-app-demo"] {
        assert!(v
            .validate_image_remove(&ImageRemoveRequest {
                image: image.to_string(),
                all_tags: true,
            })
            .is_ok());
    }
    for image in [
        "registry:5000/app-demo:latest",
        "registry:5000/app-demo@sha256:abc",
        "registry:5000/app-*",
        "docker.io/library/postgres",
        "registry:5000/ploydok-api",
    ] {
        assert!(v
            .validate_image_remove(&ImageRemoveRequest {
                image: image.to_string(),
                all_tags: true,
            })
            .is_err());
    }
}

#[test]
fn test_build_cache_prune_requires_bounded_retention() {
    let v = make_validator();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs() as i64;
    let valid = BuildCachePruneRequest {
        until_unix: now - 7 * 24 * 60 * 60,
        keep_storage_bytes: 10 * 1024 * 1024 * 1024,
    };
    assert!(v.validate_build_cache_prune(&valid).is_ok());

    for invalid in [
        BuildCachePruneRequest {
            until_unix: 0,
            keep_storage_bytes: valid.keep_storage_bytes,
        },
        BuildCachePruneRequest {
            until_unix: now + 60,
            keep_storage_bytes: valid.keep_storage_bytes,
        },
        BuildCachePruneRequest {
            until_unix: valid.until_unix,
            keep_storage_bytes: 0,
        },
    ] {
        let err = v.validate_build_cache_prune(&invalid).unwrap_err();
        assert_eq!(err.code(), Code::InvalidArgument);
    }
}

#[test]
fn test_registry_gc_rejects_non_normalized_or_foreign_paths() {
    let v = make_validator();
    for config_path in ["", "/etc/docker/registry/config.yml"] {
        assert!(v
            .validate_registry_garbage_collect(&RegistryGarbageCollectRequest {
                config_path: config_path.to_string(),
            })
            .is_ok());
    }

    for config_path in [
        "/etc/docker/registry/../secret.yml",
        "/etc/docker/registry/./config.yml",
        "/etc/passwd",
        "etc/docker/registry/config.yml",
    ] {
        let err = v
            .validate_registry_garbage_collect(&RegistryGarbageCollectRequest {
                config_path: config_path.to_string(),
            })
            .unwrap_err();
        assert!(matches!(
            err.code(),
            Code::PermissionDenied | Code::InvalidArgument
        ));
    }
}

#[test]
fn test_user_uid_zero_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.user = "0".to_string();
    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
}

#[test]
fn test_memory_over_limit_is_denied() {
    let v = make_validator();
    let mut req = valid_create();
    req.resource_limits = Some(ResourceLimits {
        cpu: 1.0,
        memory_bytes: 16 * 1024 * 1024 * 1024, // 16 GiB
        pids_limit: 0,
    });
    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::InvalidArgument);
    assert!(err.message().contains("resource_memory_limit"));
}

// ─── Sprint-3bis: multi-network support ──────────────────────────────────────

#[test]
fn test_multi_networks_ploydok_prefix_ok() {
    let v = make_validator();
    let mut req = valid_create();
    req.network = String::new();
    req.networks = vec![
        "ploydok-proj-abc".to_string(),
        "ploydok-ingress".to_string(),
    ];
    assert!(v.validate_container_create(&req).is_ok());
}

#[test]
fn test_multi_networks_rejects_host() {
    let v = make_validator();
    let mut req = valid_create();
    req.network = String::new();
    req.networks = vec!["ploydok-proj-abc".to_string(), "host".to_string()];
    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(err.message().contains("network_host_forbidden"));
}

#[test]
fn test_multi_networks_rejects_bad_prefix() {
    let v = make_validator();
    let mut req = valid_create();
    req.network = String::new();
    req.networks = vec!["evil-net".to_string()];
    let err = v.validate_container_create(&req).unwrap_err();
    assert_eq!(err.code(), Code::PermissionDenied);
    assert!(err.message().contains("network_prefix"));
}

#[test]
fn test_workload_rejects_control_plane_networks() {
    let v = make_validator();
    for network in [
        "ploydok-management",
        "ploydok-build",
        "ploydok-monitoring",
        "ploydok-alerting",
    ] {
        let mut req = valid_create();
        req.network = String::new();
        req.networks = vec![network.to_string()];
        let err = v.validate_container_create(&req).unwrap_err();
        assert_eq!(err.code(), Code::PermissionDenied);
        assert!(err.message().contains("network_control_plane_forbidden"));
    }
}

#[test]
fn test_resolved_opaque_ids_reject_control_plane_network_names() {
    for resolved_name in [
        "ploydok-management",
        "ploydok-build",
        "ploydok-monitoring",
        "ploydok_ploydok-monitoring",
        "ploydok_ploydok-alerting",
    ] {
        let err = validate_workload_network_name(resolved_name).unwrap_err();
        assert_eq!(err.code(), Code::PermissionDenied);
    }
    assert!(validate_workload_network_name("ploydok-project-abc").is_ok());
}
