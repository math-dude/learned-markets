//! Dumps real on-chain account bytes and instruction data from a deterministic
//! run into `fixtures/onchain-accounts.json`, for cross-language decoding tests.
//! `UPDATE_FIXTURES=1 cargo test --test fixtures` rewrites the file.

use base64::Engine;
use program_tests::*;
use serde_json::{json, Value};

const PID: [u8; 32] = [0xA1; 32];

#[test]
fn onchain_account_fixtures() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let badge = env.issue_badge(PID, &alice.pubkey(), 1);
    env.register(&alice, &badge).unwrap();
    let market = Address::new_from_array([0x4d; 32]);
    let contents = sample_trade();
    let hash = payload_hash(NETWORK, KIND_TRADE, &market, &contents);
    let deadline = env.now() + 60;
    let submit = env.ix_submit_raw(&alice.pubkey(), &PID, &badge, 0, KIND_TRADE, &market, hash, deadline);
    env.send(&[submit.clone()], &[&alice]).unwrap();

    let b64 = |a: &Address| {
        let acct = env.svm.get_account(a).unwrap();
        json!({
            "address": a.to_string(),
            "owner": acct.owner.to_string(),
            "lamports": acct.lamports,
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(&acct.data),
        })
    };
    let participant = participant_pda(&PID);
    let intent = intent_pda(&participant, 0);
    let mint_space = badge_mint_space(&badge.attestation, &env.schema, BADGE_NAME, BADGE_SYMBOL, BADGE_URI);
    let settle = env.ix_settle(
        env.settle_request(&market, 42, &[(intent, contents.clone())]),
        env.settle_intent_metas(&PID, 0, &alice.pubkey(), &badge),
    );
    let register = env.ix_register(&alice.pubkey(), PID, &badge);
    let cancel = env.ix_cancel(&alice.pubkey(), &PID, 0);
    let init = env.ix_initialize_config(&env.deployer.pubkey(), NETWORK);
    let update = env.ix_update_config(&env.admin.pubkey(), Some(true), None);
    let replace = env.ix_replace(&env.admin.pubkey(), &alice.pubkey(), None, &badge);
    let metas = |ix: &solana_instruction::Instruction| -> Vec<Value> {
        ix.accounts.iter().map(|m| json!([m.pubkey.to_string(), m.is_writable, m.is_signer])).collect()
    };
    let ixj = |ix: &solana_instruction::Instruction| json!({ "dataHex": hex::encode(&ix.data), "accounts": metas(ix) });

    let value = json!({
        "programId": lm_id().to_string(),
        "sasProgramId": sas_id().to_string(),
        "appScope": APP_SCOPE,
        "network": NETWORK,
        "now": env.now(),
        "keys": {
            "admin": env.admin.pubkey().to_string(),
            "deployer": env.deployer.pubkey().to_string(),
            "settlementAuthority": env.settlement_authority.pubkey().to_string(),
            "credentialAuthority": env.credential_authority.pubkey().to_string(),
            "issuerSigner": env.issuer_signer.pubkey().to_string(),
            "wallet": alice.pubkey().to_string(),
            "payer": env.payer.pubkey().to_string(),
        },
        "participantIdHex": hex::encode(PID),
        "market": market.to_string(),
        "tradeContentsHex": hex::encode(&contents),
        "payloadHashHex": hex::encode(hash),
        "deadline": deadline,
        "badge": {
            "name": BADGE_NAME, "symbol": BADGE_SYMBOL, "uri": BADGE_URI,
            "mintAccountSpace": mint_space,
            "mintActualDataLen": env.svm.get_account(&badge.mint).unwrap().data.len(),
            "mintRentLamports": env.svm.minimum_balance_for_rent_exemption(mint_space as usize),
            "expiry": badge.expiry,
        },
        "accounts": {
            "credential": b64(&env.credential),
            "schema": b64(&env.schema),
            "schemaMint": b64(&env.schema_mint),
            "attestation": b64(&badge.attestation),
            "badgeMint": b64(&badge.mint),
            "badgeTokenAccount": b64(&badge.token_account),
            "config": b64(&config_pda()),
            "participant": b64(&participant),
            "walletBinding": b64(&wallet_binding_pda(&alice.pubkey())),
            "intent": b64(&intent),
        },
        "instructions": {
            "initializeConfig": ixj(&init),
            "updateConfig": ixj(&update),
            "registerParticipant": ixj(&register),
            "replaceBindingRenewal": ixj(&replace),
            "submitIntent": ixj(&submit),
            "cancelIntent": ixj(&cancel),
            "settleBatch": ixj(&settle),
        },
    });

    // The mint is exactly as large as the computed space: sizing is exact.
    assert_eq!(value["badge"]["mintActualDataLen"].as_u64().unwrap(), mint_space as u64);

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/onchain-accounts.json");
    let text = serde_json::to_string_pretty(&value).unwrap() + "\n";
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::write(&path, text).unwrap();
    } else {
        assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), text, "stale; rerun with UPDATE_FIXTURES=1");
    }
}
