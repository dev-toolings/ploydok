// SPDX-License-Identifier: AGPL-3.0-only

use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=src/http_probe.c");
    println!("cargo:rerun-if-changed=src/http_probe_shell.sh");
    let target = env::var("TARGET").expect("Cargo TARGET");
    let linker_key = format!(
        "CARGO_TARGET_{}_LINKER",
        target.to_uppercase().replace('-', "_")
    );
    println!("cargo:rerun-if-env-changed={linker_key}");
    let compiler = env::var(&linker_key).unwrap_or_else(|_| "cc".into());
    let directory = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    let output = directory.join("ploydok-http-probe");
    let script = std::fs::read_to_string("src/http_probe_shell.sh").expect("fixed shell probe");
    assert!(script.is_ascii(), "embedded shell probe must be ASCII");
    std::fs::write(
        directory.join("http_probe_shell.h"),
        format!("static char probe_shell[] = {script:?};\n"),
    )
    .expect("embed fixed shell probe");
    let status = Command::new(compiler)
        .args([
            "-Os",
            "-static",
            "-nostdlib",
            "-fno-builtin",
            "-fno-stack-protector",
            "-fno-pie",
            "-no-pie",
            "-Wl,--build-id=none",
            "-s",
            "-Wall",
            "-Wextra",
            "-Werror",
            "src/http_probe.c",
        ])
        .arg("-I")
        .arg(directory)
        .arg("-o")
        .arg(output)
        .status()
        .expect("compile the freestanding Linux health probe");
    assert!(
        status.success(),
        "could not compile the static HTTP health probe"
    );
}
