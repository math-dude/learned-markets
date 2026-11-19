//! Generates / verifies the shared TypeScript ⇄ Rust vectors in `fixtures/`.
//! `UPDATE_FIXTURES=1 cargo test -p learned-markets --test fixtures` rewrites them.

use anchor_lang::prelude::Pubkey;
use learned_markets::{
    constants::APP_SCOPE,
    payload::{self, CurvePoint, NominationContents, Side, TradeContents},
    sas::{self, ParticipantData},
    state::IntentKind,
};
use serde_json::{json, Value};

fn pk(b: u8) -> Pubkey {
    Pubkey::new_from_array([b; 32])
}

fn check_or_write(name: &str, value: Value) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(name);
    let text = serde_json::to_string_pretty(&value).unwrap() + "\n";
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::write(&path, text).unwrap();
        return;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(existing, text, "{name} is stale; rerun with UPDATE_FIXTURES=1");
}

fn trade(side: Side, points: &[(u64, u64)]) -> TradeContents {
    TradeContents {
        side,
        points: points.iter().map(|&(price, quantity)| CurvePoint { price, quantity }).collect(),
    }
}

#[test]
fn intent_payload_vectors() {
    let mut valid = Vec::new();
    let cases: Vec<(&str, &str, IntentKind, Pubkey, Vec<u8>)> = vec![
        ("buy curve", "devnet", IntentKind::Trade, pk(0x4d), trade(Side::Buy, &[(100, 5_000), (120, 2_000), (150, 0)]).encode()),
        ("sell curve", "devnet", IntentKind::Trade, pk(0x4d), trade(Side::Sell, &[(90, 0), (110, 1_000), (130, 1_000), (u64::MAX, u64::MAX)]).encode()),
        ("single point localnet", "localnet", IntentKind::Trade, pk(0x01), trade(Side::Buy, &[(1, 1)]).encode()),
        ("nomination", "devnet", IntentKind::Nomination, pk(0x55), NominationContents { candidate: pk(7) }.encode()),
    ];
    for (label, network, kind, target, contents) in cases {
        payload::validate_contents(kind, &contents).unwrap();
        let hash = payload::payload_hash(APP_SCOPE, network, kind, &target, &contents);
        valid.push(json!({
            "label": label,
            "appScope": APP_SCOPE,
            "network": network,
            "kind": kind.code(),
            "target": target.to_string(),
            "contentsHex": hex::encode(&contents),
            "payloadHashHex": hex::encode(hash),
        }));
    }

    let mut invalid = Vec::new();
    let mut push_invalid = |label: &str, kind: IntentKind, bytes: Vec<u8>| {
        assert!(payload::validate_contents(kind, &bytes).is_err(), "{label} should be invalid");
        invalid.push(json!({ "label": label, "kind": kind.code(), "contentsHex": hex::encode(bytes) }));
    };
    let ok_buy = trade(Side::Buy, &[(100, 5_000), (120, 2_000)]).encode();
    push_invalid("empty", IntentKind::Trade, vec![]);
    push_invalid("bad version", IntentKind::Trade, [&[2u8][..], &ok_buy[1..]].concat());
    push_invalid("bad side", IntentKind::Trade, [&ok_buy[..1], &[2u8][..], &ok_buy[2..]].concat());
    push_invalid("trailing byte", IntentKind::Trade, [&ok_buy[..], &[0u8][..]].concat());
    push_invalid("zero points", IntentKind::Trade, vec![1, 0, 0]);
    push_invalid("unsorted prices", IntentKind::Trade, trade(Side::Buy, &[(120, 5_000), (100, 2_000)]).encode());
    push_invalid("duplicate price", IntentKind::Trade, trade(Side::Buy, &[(100, 5_000), (100, 2_000)]).encode());
    push_invalid("buy quantity rises", IntentKind::Trade, trade(Side::Buy, &[(100, 1_000), (120, 2_000)]).encode());
    push_invalid("sell quantity falls", IntentKind::Trade, trade(Side::Sell, &[(100, 2_000), (120, 1_000)]).encode());
    push_invalid("zero price", IntentKind::Trade, trade(Side::Buy, &[(0, 5_000)]).encode());
    push_invalid("all zero quantity", IntentKind::Trade, trade(Side::Buy, &[(100, 0)]).encode());
    push_invalid("17 points", IntentKind::Trade, trade(Side::Sell, &(1..=17).map(|i| (i, i)).collect::<Vec<_>>()).encode());
    push_invalid("nomination short", IntentKind::Nomination, vec![1; 32]);
    push_invalid("nomination default key", IntentKind::Nomination, [&[1u8][..], &[0u8; 32][..]].concat());

    check_or_write(
        "intent-payload-vectors.json",
        json!({ "domain": "learned-markets:intent-payload", "payloadVersion": 1, "valid": valid, "invalid": invalid }),
    );
}

#[test]
fn participant_attestation_vectors() {
    let d = ParticipantData {
        app_scope: APP_SCOPE.to_string(),
        participant_id: [0xA1; 32],
        wallet: pk(0x22),
        verification_method: 0,
        binding_version: 3,
        issued_at: 1_763_600_000,
    };
    let encoded = d.encode();
    assert_eq!(ParticipantData::decode(&encoded).unwrap(), d);
    let nonces: Vec<Value> = [(0xA1u8, 1u32), (0xA1, 2), (0x00, 1)]
        .iter()
        .map(|&(b, v)| {
            json!({
                "participantIdHex": hex::encode([b; 32]),
                "bindingVersion": v,
                "nonce": sas::attestation_nonce(&[b; 32], v).to_string(),
            })
        })
        .collect();

    let mut bad_id = Vec::new();
    bad_id.extend_from_slice(&(APP_SCOPE.len() as u32).to_le_bytes());
    bad_id.extend_from_slice(APP_SCOPE.as_bytes());
    bad_id.extend_from_slice(&31u32.to_le_bytes());
    bad_id.extend_from_slice(&[1u8; 31]);
    bad_id.extend_from_slice(&32u32.to_le_bytes());
    bad_id.extend_from_slice(&[2u8; 32]);
    bad_id.push(0);
    bad_id.extend_from_slice(&1u32.to_le_bytes());
    bad_id.extend_from_slice(&0i64.to_le_bytes());
    let malformed = vec![
        json!({ "label": "trailing byte", "hex": hex::encode([&encoded[..], &[0u8][..]].concat()) }),
        json!({ "label": "truncated", "hex": hex::encode(&encoded[..encoded.len() - 1]) }),
        json!({ "label": "31-byte participant_id", "hex": hex::encode(&bad_id) }),
    ];
    for m in &malformed {
        assert!(ParticipantData::decode(&hex::decode(m["hex"].as_str().unwrap()).unwrap()).is_err());
    }

    check_or_write(
        "participant-attestation-vectors.json",
        json!({
            "layout": [12, 13, 13, 0, 2, 8],
            "fieldNames": ["app_scope", "participant_id", "wallet", "verification_method", "binding_version", "issued_at"],
            "valid": [{
                "appScope": d.app_scope,
                "participantIdHex": hex::encode(d.participant_id),
                "wallet": d.wallet.to_string(),
                "verificationMethod": d.verification_method,
                "bindingVersion": d.binding_version,
                "issuedAt": d.issued_at,
                "hex": hex::encode(&encoded),
            }],
            "malformed": malformed,
            "nonces": nonces,
        }),
    );
}
