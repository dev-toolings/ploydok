// SPDX-License-Identifier: AGPL-3.0-only
//
// Library entry point — exposes internal modules for integration tests.

pub mod audit;
pub mod audit_signer;
pub mod boot_guard;
pub mod buildkit_profile;
pub mod healthcheck;
pub mod host_stats;
pub mod pki;
// tonic::Status is the gRPC error type of every service helper; boxing it
// would only add noise at each call site.
#[allow(clippy::result_large_err)]
pub mod service;
pub mod socket_config;
pub mod validator;

// Monitor is declared inside service (as #[path = "monitor.rs"] pub mod monitor).
// Re-export here for convenience (e.g. integration tests).
pub use service::monitor;
