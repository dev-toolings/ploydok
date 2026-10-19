// SPDX-License-Identifier: AGPL-3.0-only

use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::{Command, Output},
    thread,
    time::Duration,
};

use ploydok_agent::service::http_probe;

const PROBE: &str = concat!(env!("OUT_DIR"), "/ploydok-http-probe");

fn run(mode: &str, port: u16, path: &str) -> Output {
    Command::new(PROBE)
        .args([mode, &port.to_string(), path])
        .output()
        .expect("execute static probe")
}

#[test]
fn shell_images_keep_the_existing_curl_probe_without_executing_path_content() {
    let directory = tempfile::tempdir().expect("test directory");
    let curl = directory.path().join("curl");
    std::fs::write(&curl, "#!/bin/sh\nprintf 200\n").expect("mock curl");
    std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o555)).expect("chmod curl");
    let marker = directory.path().join("injected");
    let path = format!("/ready'$(printf injected > {})", marker.display());
    let result = Command::new(PROBE)
        .env("PATH", directory.path())
        .args(["auto", "80", &path])
        .output()
        .expect("shell probe");
    assert!(result.status.success(), "{result:?}");
    assert!(!marker.exists(), "path must remain a literal argument");
}

#[test]
fn a_shell_image_without_any_http_client_names_the_impossible_probe() {
    let directory = tempfile::tempdir().expect("empty PATH");
    let result = Command::new(PROBE)
        .env("PATH", directory.path())
        .args(["auto", "80", "/"])
        .output()
        .expect("probe");
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("healthcheck impossible: /bin/sh exists but no supported HTTP client"));
}

#[test]
fn native_probe_requires_http_and_accepts_the_existing_2xx_to_4xx_range() {
    for status in [200, 404, 500] {
        let listener = TcpListener::bind("127.0.0.1:0").expect("HTTP listener");
        let port = listener.local_addr().expect("port").port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut request = [0; 2048];
            let n = socket.read(&mut request).expect("request");
            assert!(String::from_utf8_lossy(&request[..n])
                .starts_with("GET /ready%20path HTTP/1.1\r\n"));
            write!(
                socket,
                "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\n\r\n"
            )
            .expect("response");
        });
        let result = run("http", port, "/ready path");
        server.join().expect("HTTP server");
        assert_eq!(result.status.success(), status < 500, "{result:?}");
    }
}

#[test]
fn a_tcp_listener_that_never_answers_is_not_healthy() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("silent listener");
    let port = listener.local_addr().expect("port").port();
    let server = thread::spawn(move || {
        let (_socket, _) = listener.accept().expect("accept");
        thread::sleep(Duration::from_millis(1400));
    });
    let result = run("http", port, "/");
    server.join().expect("silent server");
    assert!(!result.status.success());
    let cause = String::from_utf8_lossy(&result.stderr);
    assert!(cause.contains("no executable /bin/sh"), "{cause}");
    assert!(cause.contains("no 2xx-4xx response"), "{cause}");
}

#[test]
fn managed_probe_arguments_are_validated_at_the_agent_boundary() {
    let valid: Vec<String> = ["PLOYDOK-HTTP", "8080", "/ready path"]
        .map(String::from)
        .into();
    assert!(http_probe::validate(&valid).is_ok());
    for invalid in [
        vec!["PLOYDOK-HTTP"],
        vec!["PLOYDOK-HTTP", "0", "/"],
        vec!["PLOYDOK-HTTP", "65536", "/"],
        vec!["PLOYDOK-HTTP", "80", "/\r\nInjected: header"],
        vec!["PLOYDOK-HTTP", "80", "http://foreign-host/"],
    ] {
        let invalid: Vec<_> = invalid.into_iter().map(String::from).collect();
        assert!(http_probe::validate(&invalid).is_err(), "{invalid:?}");
    }
    assert!(http_probe::validate_mounts(&valid, ["/__ploydok_health/probe"].into_iter()).is_err());
}

#[test]
fn inspect_update_round_trips_restore_the_native_health_gate_and_reject_shell_code() {
    let test = ["PLOYDOK-HTTP", "8080", "/ready"].map(String::from);
    let health = bollard::models::HealthConfig {
        test: Some(http_probe::docker_test(&test)),
        interval: Some(5_000_000_000),
        retries: Some(6),
        ..Default::default()
    };
    let mut spec = bollard::models::ServiceSpec {
        task_template: Some(bollard::models::TaskSpec {
            container_spec: Some(bollard::models::TaskSpecContainerSpec {
                health_check: Some(health.clone()),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    http_probe::remember_service_healthcheck(&mut spec);
    let mut raw = serde_json::to_value(spec).expect("wire spec");
    let container = raw["TaskTemplate"]["ContainerSpec"]
        .as_object_mut()
        .expect("container");
    let gate = container.remove("HealthCheck").expect("Bollard field");
    container.insert("Healthcheck".into(), gate);
    let mut round_trip = serde_json::from_value(raw.clone()).expect("Docker inspect");
    http_probe::restore_service_healthcheck(&mut round_trip).expect("restore native gate");
    assert_eq!(
        round_trip
            .task_template
            .expect("task")
            .container_spec
            .expect("container")
            .health_check,
        Some(health)
    );
    raw["TaskTemplate"]["ContainerSpec"]["Labels"]["ploydok.native-http-healthcheck"] =
        serde_json::Value::String(r#"{"Test":["CMD-SHELL","exit 0"]}"#.into());
    let mut forged = serde_json::from_value(raw).expect("forged contract");
    assert!(http_probe::restore_service_healthcheck(&mut forged).is_err());
}
