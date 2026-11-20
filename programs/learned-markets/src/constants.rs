use anchor_lang::prelude::*;

/// Application scope written into every participant attestation and the registry config.
pub const APP_SCOPE: &str = "learned-markets:demo";

pub const CONFIG_SEED: &[u8] = b"config";
pub const PARTICIPANT_SEED: &[u8] = b"participant";
pub const WALLET_BINDING_SEED: &[u8] = b"wallet-binding";
pub const INTENT_SEED: &[u8] = b"intent";

/// Solana Attestation Service program (same address on devnet and mainnet).
pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// SAS PDA seeds (see solana-attestation-service `constants.rs`).
pub const SAS_ATTESTATION_SEED: &[u8] = b"attestation";
pub const SAS_SCHEMA_MINT_SEED: &[u8] = b"schemaMint";
pub const SAS_ATTESTATION_MINT_SEED: &[u8] = b"attestationMint";
pub const SAS_AUTHORITY_SEED: &[u8] = b"sas";

/// SAS account discriminators.
pub const SAS_CREDENTIAL_DISCRIMINATOR: u8 = 0;
pub const SAS_SCHEMA_DISCRIMINATOR: u8 = 1;
pub const SAS_ATTESTATION_DISCRIMINATOR: u8 = 2;

/// Participant schema `learned-markets-participant` v1:
/// app_scope String, participant_id VecU8, wallet VecU8, verification_method U8,
/// binding_version U32, issued_at I64.
pub const SCHEMA_NAME: &str = "learned-markets-participant";
pub const SCHEMA_LAYOUT: [u8; 6] = [12, 13, 13, 0, 2, 8];

/// `verification_method = 0`: operator-approved test participant.
pub const VERIFICATION_METHOD_OPERATOR_APPROVED: u8 = 0;

/// Badge validity may not exceed seven days from issuance.
pub const MAX_ATTESTATION_LIFETIME_SECS: i64 = 7 * 24 * 60 * 60;
/// Tolerated clock skew for `issued_at` ahead of the on-chain clock.
pub const MAX_ISSUED_AT_FUTURE_SKEW_SECS: i64 = 30;
/// Intents are valid for at most five minutes.
pub const MAX_INTENT_LIFETIME_SECS: i64 = 5 * 60;

/// Domain separator for deterministic attestation nonces:
/// nonce = sha256(domain || participant_id || binding_version_le).
pub const ATTESTATION_NONCE_DOMAIN: &[u8] = b"learned-markets:attestation-nonce:v1";

/// Domain separator for canonical intent payload hashes.
pub const INTENT_PAYLOAD_DOMAIN: &[u8] = b"learned-markets:intent-payload";
pub const INTENT_PAYLOAD_VERSION: u8 = 1;

pub const MAX_APP_SCOPE_LEN: usize = 32;
pub const MAX_NETWORK_LEN: usize = 16;

/// Settlement request limits.
pub const SETTLEMENT_REQUEST_VERSION: u8 = 1;
pub const MAX_SETTLEMENT_INTENTS: usize = 8;
/// Accounts per intent in `settle_batch` remaining accounts:
/// intent, participant, wallet binding, attestation, badge mint, badge token account.
pub const SETTLEMENT_ACCOUNTS_PER_INTENT: usize = 6;
