// SPDX-License-Identifier: AGPL-3.0-only
//
// Compiles packages/agent-proto/proto/agent.proto into Rust bindings.
// The .proto file is the canonical source of truth for the ploydok.agent.v1 package.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Path relative to this crate root (agent/crates/ploydok-proto/).
    let proto_root = "../../../packages/agent-proto/proto";

    // CI and the installer do not need a system-wide protoc package.
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);

    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(&[&format!("{proto_root}/agent.proto")], &[proto_root])?;

    // Rebuild if the .proto file changes.
    println!("cargo:rerun-if-changed={proto_root}/agent.proto");

    Ok(())
}
