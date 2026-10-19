// SPDX-License-Identifier: AGPL-3.0-only
//
// Integration tests for the audit signer module.

use ed25519_dalek::{Verifier, VerifyingKey};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;

use ploydok_agent::audit_signer::AuditSigner;

#[test]
fn test_bootstrap_creates_key_file_with_correct_permissions() {
    let dir = TempDir::new().unwrap();
    let key_path = dir.path().join("audit-ed25519.key");

    // Bootstrap should create the file
    let _signer = AuditSigner::bootstrap(dir.path()).expect("bootstrap should succeed");

    // File should exist
    assert!(key_path.exists(), "key file should be created");

    // Check permissions are 0o400 (read-only)
    let perms = fs::metadata(&key_path).unwrap().permissions();
    let mode = perms.mode() & 0o777;
    assert_eq!(
        mode, 0o400,
        "key file should have mode 0o400, got {:o}",
        mode
    );
}

#[test]
fn test_bootstrap_idempotent() {
    let dir = TempDir::new().unwrap();

    // First bootstrap
    let signer1 = AuditSigner::bootstrap(dir.path()).expect("first bootstrap should succeed");
    let (pubkey1, kid1) = signer1.pubkey();

    // Second bootstrap should reuse the same key
    let signer2 = AuditSigner::bootstrap(dir.path()).expect("second bootstrap should succeed");
    let (pubkey2, kid2) = signer2.pubkey();

    // Public keys should be identical
    assert_eq!(pubkey1, pubkey2, "reloaded key should match original");
    assert_eq!(kid1, kid2, "reloaded kid should match original");
}

#[test]
fn test_sign_and_verify() {
    let dir = TempDir::new().unwrap();
    let signer = AuditSigner::bootstrap(dir.path()).expect("bootstrap should succeed");

    let payload =
        b"v1\n123\n2024-01-01T00:00:00Z\nuser1\nlog_event\ncontainer\napp-1\nsh256hash\n-\nhash";
    let (signature, kid) = signer.sign(payload);
    let (pubkey_bytes, kid_returned) = signer.pubkey();

    // Verify that the kid is non-empty and matches
    assert!(!kid.is_empty(), "kid should not be empty");
    assert_eq!(
        kid, kid_returned,
        "kid returned from sign and pubkey should match"
    );

    // Verify the signature using the public key
    let verifying_key = VerifyingKey::from_bytes(
        &pubkey_bytes[..]
            .try_into()
            .expect("pubkey should be 32 bytes"),
    )
    .expect("pubkey should be valid");

    verifying_key
        .verify(payload, &signature)
        .expect("signature should verify");
}

#[test]
fn test_signature_mismatch_detects_tampering() {
    let dir = TempDir::new().unwrap();
    let signer = AuditSigner::bootstrap(dir.path()).expect("bootstrap should succeed");

    let payload = b"original payload";
    let (signature, _) = signer.sign(payload);
    let (pubkey_bytes, _) = signer.pubkey();

    let verifying_key = VerifyingKey::from_bytes(
        &pubkey_bytes[..]
            .try_into()
            .expect("pubkey should be 32 bytes"),
    )
    .expect("pubkey should be valid");

    // Verify fails with different payload
    let wrong_payload = b"tampered payload";
    assert!(
        verifying_key.verify(wrong_payload, &signature).is_err(),
        "signature should not verify with wrong payload"
    );
}

#[test]
fn test_multiple_signings_produce_valid_signatures() {
    let dir = TempDir::new().unwrap();
    let signer = AuditSigner::bootstrap(dir.path()).expect("bootstrap should succeed");
    let (pubkey_bytes, _) = signer.pubkey();

    let verifying_key = VerifyingKey::from_bytes(
        &pubkey_bytes[..]
            .try_into()
            .expect("pubkey should be 32 bytes"),
    )
    .expect("pubkey should be valid");

    // Sign multiple payloads
    for i in 0..3 {
        let payload = format!("payload-{}", i).into_bytes();
        let (signature, _) = signer.sign(&payload);

        verifying_key
            .verify(&payload, &signature)
            .unwrap_or_else(|_| panic!("signature {} should verify", i));
    }
}

#[test]
fn test_key_file_format() {
    let dir = TempDir::new().unwrap();
    let key_path = dir.path().join("audit-ed25519.key");

    let _signer = AuditSigner::bootstrap(dir.path()).expect("bootstrap should succeed");

    // Read the raw file and verify its structure
    let content = fs::read(&key_path).expect("should read key file");

    // Should have at least 32 bytes (Ed25519 secret) + trailer
    assert!(
        content.len() > 32,
        "key file should have content beyond 32 bytes"
    );

    // First 32 bytes are the secret key
    let _secret = &content[0..32];

    // Remaining bytes should contain the kid trailer
    let trailer = String::from_utf8_lossy(&content[32..]);
    assert!(
        trailer.contains("# kid="),
        "trailer should contain kid marker, got: {}",
        trailer
    );
}

#[test]
fn test_bootstrap_with_explicit_key_dir() {
    let dir = TempDir::new().unwrap();
    let subdir = dir.path().join("subdir");

    // Bootstrap in a non-existent subdirectory should create it
    let signer = AuditSigner::bootstrap(&subdir).expect("bootstrap should create dir");

    assert!(subdir.exists(), "key directory should be created");

    let key_path = subdir.join("audit-ed25519.key");
    assert!(key_path.exists(), "key file should be created in subdir");

    // Verify the key works
    let payload = b"test";
    let (signature, _) = signer.sign(payload);
    let (pubkey_bytes, _) = signer.pubkey();

    let verifying_key = VerifyingKey::from_bytes(
        &pubkey_bytes[..]
            .try_into()
            .expect("pubkey should be 32 bytes"),
    )
    .expect("pubkey should be valid");

    verifying_key
        .verify(payload, &signature)
        .expect("signature should verify");
}
