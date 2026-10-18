// SPDX-License-Identifier: AGPL-3.0-only
//
// Swarm BuildKit security profile.
//
// The rootless BuildKit worker needs AppArmor and seccomp relaxed (the same
// profile the Compose descriptor gets through `security_opt`). Swarm ignores
// `security_opt`, and `docker stack deploy` resets the service privileges on
// every deploy, so the agent reapplies them to the single Ploydok infra
// service labelled `ploydok.component=buildkitd`. Nothing else is touched.

use std::collections::HashMap;
use std::time::Duration;

use bollard::models::{
    ServiceSpec, TaskSpecContainerSpecPrivileges, TaskSpecContainerSpecPrivilegesAppArmor,
    TaskSpecContainerSpecPrivilegesAppArmorModeEnum, TaskSpecContainerSpecPrivilegesSeccomp,
    TaskSpecContainerSpecPrivilegesSeccompModeEnum,
};
use bollard::service::{InspectServiceOptions, ListServicesOptions, UpdateServiceOptions};
use tokio::time::{interval, MissedTickBehavior};
use tracing::{info, warn};

const BUILDKIT_LABELS: [&str; 2] = ["ploydok.kind=infra", "ploydok.component=buildkitd"];
const RECONCILE_PERIOD: Duration = Duration::from_secs(30);

/// True when the service still runs under Docker's default AppArmor or seccomp profile.
pub fn needs_relaxed_profile(spec: &ServiceSpec) -> bool {
    let privileges = spec
        .task_template
        .as_ref()
        .and_then(|task| task.container_spec.as_ref())
        .and_then(|container| container.privileges.as_ref());
    let app_armor = privileges
        .and_then(|p| p.app_armor.as_ref())
        .and_then(|a| a.mode);
    let seccomp = privileges
        .and_then(|p| p.seccomp.as_ref())
        .and_then(|s| s.mode);
    app_armor != Some(TaskSpecContainerSpecPrivilegesAppArmorModeEnum::DISABLED)
        || seccomp != Some(TaskSpecContainerSpecPrivilegesSeccompModeEnum::UNCONFINED)
}

/// Relax AppArmor and seccomp, keeping every other privilege as deployed.
pub fn relax_profile(spec: &mut ServiceSpec) -> bool {
    let Some(container) = spec
        .task_template
        .as_mut()
        .and_then(|task| task.container_spec.as_mut())
    else {
        return false;
    };
    let privileges = container
        .privileges
        .get_or_insert_with(TaskSpecContainerSpecPrivileges::default);
    privileges.app_armor = Some(TaskSpecContainerSpecPrivilegesAppArmor {
        mode: Some(TaskSpecContainerSpecPrivilegesAppArmorModeEnum::DISABLED),
    });
    privileges.seccomp = Some(TaskSpecContainerSpecPrivilegesSeccomp {
        mode: Some(TaskSpecContainerSpecPrivilegesSeccompModeEnum::UNCONFINED),
        profile: None,
    });
    true
}

async fn reconcile_once(docker: &bollard::Docker) -> Result<(), bollard::errors::Error> {
    let services = docker
        .list_services(Some(ListServicesOptions::<String> {
            filters: HashMap::from([(
                "label".to_string(),
                BUILDKIT_LABELS.iter().map(|l| l.to_string()).collect(),
            )]),
            ..Default::default()
        }))
        .await?;
    for summary in services {
        let Some(id) = summary.id else { continue };
        let current = docker
            .inspect_service(
                &id,
                Some(InspectServiceOptions {
                    insert_defaults: false,
                }),
            )
            .await?;
        let Some(mut spec) = current.spec else {
            continue;
        };
        if !needs_relaxed_profile(&spec) || !relax_profile(&mut spec) {
            continue;
        }
        let version = current.version.and_then(|v| v.index).unwrap_or(0);
        let name = spec.name.clone().unwrap_or_else(|| id.clone());
        docker
            .update_service(
                &id,
                spec,
                UpdateServiceOptions {
                    version,
                    registry_auth_from: true,
                    rollback: false,
                },
                None,
            )
            .await?;
        info!(service = %name, "BuildKit security profile reapplied");
    }
    Ok(())
}

/// Reapply the profile now and after every stack deploy, as long as the agent runs.
pub fn spawn_reconcile_task(docker: bollard::Docker) {
    tokio::spawn(async move {
        let mut ticker = interval(RECONCILE_PERIOD);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(err) = reconcile_once(&docker).await {
                warn!(error = %err, "BuildKit security profile reconcile failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::models::{TaskSpec, TaskSpecContainerSpec};

    fn spec(privileges: Option<TaskSpecContainerSpecPrivileges>) -> ServiceSpec {
        ServiceSpec {
            task_template: Some(TaskSpec {
                container_spec: Some(TaskSpecContainerSpec {
                    privileges,
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn default_profile_needs_relaxing_then_is_stable() {
        let mut deployed = spec(None);
        assert!(needs_relaxed_profile(&deployed));
        assert!(relax_profile(&mut deployed));
        assert!(!needs_relaxed_profile(&deployed));
    }

    #[test]
    fn relaxing_keeps_other_privileges() {
        let mut deployed = spec(Some(TaskSpecContainerSpecPrivileges {
            no_new_privileges: Some(true),
            ..Default::default()
        }));
        relax_profile(&mut deployed);
        let privileges = deployed
            .task_template
            .and_then(|t| t.container_spec)
            .and_then(|c| c.privileges)
            .expect("privileges");
        assert_eq!(privileges.no_new_privileges, Some(true));
    }

    #[test]
    fn half_relaxed_profile_is_completed() {
        let deployed = spec(Some(TaskSpecContainerSpecPrivileges {
            app_armor: Some(TaskSpecContainerSpecPrivilegesAppArmor {
                mode: Some(TaskSpecContainerSpecPrivilegesAppArmorModeEnum::DISABLED),
            }),
            ..Default::default()
        }));
        assert!(needs_relaxed_profile(&deployed));
    }

    #[test]
    fn spec_without_container_is_left_alone() {
        let mut deployed = ServiceSpec::default();
        assert!(!relax_profile(&mut deployed));
    }
}
