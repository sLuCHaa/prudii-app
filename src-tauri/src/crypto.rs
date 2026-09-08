//! Passphrase-based encryption for backup payloads: PBKDF2-HMAC-SHA256 -> AES-256-GCM,
//! serialized as a self-describing JSON envelope so old archives stay readable.

use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;

pub const KDF_ITERATIONS: u32 = 600_000;

const KDF_NAME: &str = "pbkdf2-sha256";
const ENVELOPE_VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const KEY_LEN: usize = 32;

pub const MIN_PASSPHRASE_LEN: usize = 8;

/// A crafted archive must not be able to wedge a restore in the KDF for hours.
const MIN_KDF_ITERATIONS: u32 = 1;
const MAX_KDF_ITERATIONS: u32 = 10_000_000;

pub const WRONG_PASSPHRASE: &str = "Wrong passphrase or corrupted data";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    pub kdf: String,
    pub iterations: u32,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> Result<[u8; KEY_LEN], String> {
    let iterations = NonZeroU32::new(iterations).ok_or("Invalid KDF iterations")?;
    let mut key = [0u8; KEY_LEN];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        passphrase.as_bytes(),
        &mut key,
    );
    Ok(key)
}

/// The header fields are authenticated as AAD, so tampering with the KDF parameters
/// fails the tag instead of silently changing how the key is derived.
fn header_aad(version: u8, kdf: &str, iterations: u32, salt_b64: &str) -> String {
    format!("{}|{}|{}|{}", version, kdf, iterations, salt_b64)
}

fn aead_key(passphrase: &str, salt: &[u8], iterations: u32) -> Result<LessSafeKey, String> {
    let key_bytes = derive_key(passphrase, salt, iterations)?;
    let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes).map_err(|_| "Failed to build key".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

/// Encrypts `plaintext` under `passphrase` and returns the envelope JSON.
pub fn encrypt_with_passphrase(plaintext: &[u8], passphrase: &str) -> Result<String, String> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        return Err("Passphrase too short".into());
    }

    let rng = SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    rng.fill(&mut salt).map_err(|_| "Failed to generate salt".to_string())?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut nonce_bytes).map_err(|_| "Failed to generate nonce".to_string())?;

    let salt_b64 = b64().encode(salt);
    let aad = header_aad(ENVELOPE_VERSION, KDF_NAME, KDF_ITERATIONS, &salt_b64);

    let key = aead_key(passphrase, &salt, KDF_ITERATIONS)?;
    let mut buf = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(aad.as_bytes()),
        &mut buf,
    )
    .map_err(|_| "Encryption failed".to_string())?;

    let envelope = Envelope {
        v: ENVELOPE_VERSION,
        kdf: KDF_NAME.into(),
        iterations: KDF_ITERATIONS,
        salt: salt_b64,
        nonce: b64().encode(nonce_bytes),
        ciphertext: b64().encode(&buf),
    };
    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

/// Decrypts an envelope produced by `encrypt_with_passphrase`.
/// A wrong passphrase and a tampered ciphertext are indistinguishable by design.
pub fn decrypt_with_passphrase(envelope_json: &str, passphrase: &str) -> Result<Vec<u8>, String> {
    let envelope: Envelope =
        serde_json::from_str(envelope_json).map_err(|e| format!("Invalid envelope: {}", e))?;
    if envelope.v != ENVELOPE_VERSION {
        return Err(format!("Unsupported envelope version: {}", envelope.v));
    }
    if envelope.kdf != KDF_NAME {
        return Err(format!("Unsupported key derivation: {}", envelope.kdf));
    }
    if !(MIN_KDF_ITERATIONS..=MAX_KDF_ITERATIONS).contains(&envelope.iterations) {
        return Err("Unsupported KDF iterations".into());
    }

    let salt = b64().decode(&envelope.salt).map_err(|_| "Invalid envelope: salt".to_string())?;
    let nonce_bytes = b64().decode(&envelope.nonce).map_err(|_| "Invalid envelope: nonce".to_string())?;
    let nonce = Nonce::try_assume_unique_for_key(&nonce_bytes)
        .map_err(|_| "Invalid envelope: nonce".to_string())?;
    let mut buf = b64()
        .decode(&envelope.ciphertext)
        .map_err(|_| "Invalid envelope: ciphertext".to_string())?;

    let aad = header_aad(envelope.v, &envelope.kdf, envelope.iterations, &envelope.salt);
    let key = aead_key(passphrase, &salt, envelope.iterations)?;
    let plaintext = key
        .open_in_place(nonce, Aad::from(aad.as_bytes()), &mut buf)
        .map_err(|_| WRONG_PASSPHRASE.to_string())?;
    Ok(plaintext.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSPHRASE: &str = "correct horse battery";

    #[test]
    fn roundtrip_returns_the_original_plaintext() {
        let plaintext = br#"[{"account_id":"a1","email":"a@b.c","secret":"hunter22"}]"#;
        let envelope = encrypt_with_passphrase(plaintext, PASSPHRASE).unwrap();
        let decrypted = decrypt_with_passphrase(&envelope, PASSPHRASE).unwrap();
        assert_eq!(decrypted, plaintext.to_vec());
    }

    #[test]
    fn a_wrong_passphrase_fails() {
        let envelope = encrypt_with_passphrase(b"secret payload", PASSPHRASE).unwrap();
        let err = decrypt_with_passphrase(&envelope, "wrong passphrase").unwrap_err();
        assert_eq!(err, WRONG_PASSPHRASE);
    }

    #[test]
    fn a_flipped_ciphertext_byte_fails() {
        let envelope_json = encrypt_with_passphrase(b"secret payload", PASSPHRASE).unwrap();
        let mut envelope: Envelope = serde_json::from_str(&envelope_json).unwrap();
        let mut bytes = b64().decode(&envelope.ciphertext).unwrap();
        bytes[0] ^= 0x01;
        envelope.ciphertext = b64().encode(&bytes);

        let tampered = serde_json::to_string(&envelope).unwrap();
        let err = decrypt_with_passphrase(&tampered, PASSPHRASE).unwrap_err();
        assert_eq!(err, WRONG_PASSPHRASE);
    }

    #[test]
    fn a_too_short_passphrase_is_rejected() {
        let err = encrypt_with_passphrase(b"secret payload", "short7!").unwrap_err();
        assert_eq!(err, "Passphrase too short");
    }

    #[test]
    fn an_envelope_sealed_without_the_header_aad_is_rejected() {
        // Seals a structurally valid envelope without binding the header, proving `open`
        // really requires the AAD rather than only the KDF parameters matching.
        let salt = [7u8; SALT_LEN];
        let nonce_bytes = [9u8; NONCE_LEN];
        let key = aead_key(PASSPHRASE, &salt, KDF_ITERATIONS).unwrap();
        let mut buf = b"secret payload".to_vec();
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::empty(),
            &mut buf,
        )
        .unwrap();

        let envelope = Envelope {
            v: ENVELOPE_VERSION,
            kdf: KDF_NAME.into(),
            iterations: KDF_ITERATIONS,
            salt: b64().encode(salt),
            nonce: b64().encode(nonce_bytes),
            ciphertext: b64().encode(&buf),
        };
        let unbound = serde_json::to_string(&envelope).unwrap();
        let err = decrypt_with_passphrase(&unbound, PASSPHRASE).unwrap_err();
        assert_eq!(err, WRONG_PASSPHRASE);
    }

    #[test]
    fn iterations_outside_the_accepted_range_are_rejected() {
        let envelope_json = encrypt_with_passphrase(b"secret payload", PASSPHRASE).unwrap();

        for iterations in [0, MAX_KDF_ITERATIONS + 1] {
            let mut envelope: Envelope = serde_json::from_str(&envelope_json).unwrap();
            envelope.iterations = iterations;
            let crafted = serde_json::to_string(&envelope).unwrap();
            let err = decrypt_with_passphrase(&crafted, PASSPHRASE).unwrap_err();
            assert_eq!(err, "Unsupported KDF iterations");
        }
    }

    #[test]
    fn a_tampered_header_fails_the_tag() {
        let envelope_json = encrypt_with_passphrase(b"secret payload", PASSPHRASE).unwrap();
        let mut envelope: Envelope = serde_json::from_str(&envelope_json).unwrap();
        envelope.iterations = KDF_ITERATIONS - 1;

        let tampered = serde_json::to_string(&envelope).unwrap();
        let err = decrypt_with_passphrase(&tampered, PASSPHRASE).unwrap_err();
        assert_eq!(err, WRONG_PASSPHRASE);
    }

    #[test]
    fn the_envelope_carries_the_agreed_kdf_parameters() {
        let envelope_json = encrypt_with_passphrase(b"secret payload", PASSPHRASE).unwrap();
        let envelope: Envelope = serde_json::from_str(&envelope_json).unwrap();

        assert_eq!(envelope.v, 1);
        assert_eq!(envelope.kdf, "pbkdf2-sha256");
        assert_eq!(envelope.iterations, 600_000);
        assert_eq!(b64().decode(&envelope.salt).unwrap().len(), 16);
        assert_eq!(b64().decode(&envelope.nonce).unwrap().len(), 12);
    }
}
