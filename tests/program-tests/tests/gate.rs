//! On-chain acceptance tests for the registry, the shared eligibility guard,
//! gated intents and the settlement scaffold.

use program_tests::*;
use solana_instruction::{AccountMeta, Instruction};

const PID_A: [u8; 32] = [0xA1; 32];
const PID_B: [u8; 32] = [0xB2; 32];

struct Registered {
    env: Env,
    alice: Kp,
    badge: Badge,
}

fn ok(r: TxResult) -> litesvm::types::TransactionMetadata {
    match r {
        Ok(m) => m,
        Err(e) => panic!("{:?}\n{}", e.err, e.logs.join("\n")),
    }
}

fn registered() -> Registered {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let badge = env.issue_badge(PID_A, &alice.pubkey(), 1);
    ok(env.register(&alice, &badge));
    Registered { env, alice, badge }
}

fn market() -> Address {
    Address::new_from_array([0x4d; 32])
}

// ---------------------------------------------------------------- config

#[test]
fn config_init_requires_deployment_authority() {
    let mut env = Env::bare();
    let mallory = env.new_wallet(90);
    let ix = env.ix_initialize_config(&mallory.pubkey(), NETWORK);
    expect_err(env.send(&[ix], &[&mallory]), "NotDeploymentAuthority");

    // Immutable program (no upgrade authority) cannot be initialized by anyone.
    env.set_upgrade_authority(&lm_id(), None);
    let deployer = env.deployer.insecure_clone();
    let ix = env.ix_initialize_config(&deployer.pubkey(), NETWORK);
    expect_err(env.send(&[ix], &[&deployer]), "NotDeploymentAuthority");

    env.set_upgrade_authority(&lm_id(), Some(deployer.pubkey()));
    let ix = env.ix_initialize_config(&deployer.pubkey(), NETWORK);
    ok(env.send(&[ix], &[&deployer]));
    let c = env.config();
    assert_eq!(c.app_scope, APP_SCOPE);
    assert_eq!(c.schema_mint, env.schema_mint);
    assert_eq!(c.sas_authority, sas_authority_pda());

    // Second initialization fails (PDA exists).
    let ix = env.ix_initialize_config(&deployer.pubkey(), NETWORK);
    expect_fail(env.send(&[ix], &[&deployer]));
}

#[test]
fn config_updates_require_admin() {
    let mut env = Env::new();
    let mallory = env.new_wallet(90);
    let ix = env.ix_update_config(&mallory.pubkey(), Some(true), None);
    expect_err(env.send(&[ix], &[&mallory]), "NotAdmin");
    let admin = env.admin.insecure_clone();
    let ix = env.ix_update_config(&admin.pubkey(), Some(true), None);
    ok(env.send(&[ix], &[&admin]));
    assert!(env.config().admission_paused);
}

// ---------------------------------------------------------------- registration

#[test]
fn registration_records_binding() {
    let Registered { env, alice, badge } = registered();
    let p = env.participant(&PID_A);
    assert_eq!(p.current_wallet, alice.pubkey());
    assert_eq!(p.current_attestation, badge.attestation);
    assert_eq!(p.current_badge_mint, badge.mint);
    assert_eq!(p.binding_version, 1);
    assert_eq!(p.status, ParticipantStatus::Active);
    assert_eq!(p.next_intent_nonce, 0);
    let b = env.binding(&alice.pubkey());
    assert!(b.active);
    assert_eq!(b.participant, participant_pda(&PID_A));
}

#[test]
fn unapproved_wallet_cannot_register_with_someone_elses_badge() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let mallory = env.new_wallet(90);
    let badge = env.issue_badge(PID_A, &alice.pubkey(), 1);
    // Mallory signs, presenting Alice's badge accounts.
    let ix = env.ix_register(&mallory.pubkey(), PID_A, &badge);
    expect_err(env.send(&[ix], &[&mallory]), "WalletMismatch");
}

#[test]
fn registration_requires_wallet_signature() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let badge = env.issue_badge(PID_A, &alice.pubkey(), 1);
    let mut ix = env.ix_register(&alice.pubkey(), PID_A, &badge);
    ix.accounts[1].is_signer = false;
    expect_fail(env.send(&[ix], &[]));
}

#[test]
fn registration_rejects_participant_id_mismatch() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let badge = env.issue_badge(PID_A, &alice.pubkey(), 1);
    let ix = env.ix_register(&alice.pubkey(), PID_B, &badge);
    expect_err(env.send(&[ix], &[&alice]), "ParticipantMismatch");
}

#[test]
fn second_wallet_cannot_register_over_active_participant() {
    let Registered { mut env, .. } = registered();
    let bob = env.new_wallet(11);
    // Even a genuine v2 badge for the same participant cannot be used to register again.
    let badge2 = env.issue_badge(PID_A, &bob.pubkey(), 2);
    expect_fail(env.register(&bob, &badge2));
    assert_eq!(env.participant(&PID_A).current_wallet, env.participant(&PID_A).current_wallet);
    assert!(env.account(&wallet_binding_pda(&bob.pubkey())).is_none());
}

#[test]
fn one_wallet_cannot_register_as_another_participant() {
    let Registered { mut env, alice, .. } = registered();
    let badge_b = env.issue_badge(PID_B, &alice.pubkey(), 1);
    // Wallet binding already exists for Alice.
    expect_fail(env.register(&alice, &badge_b));
    assert!(env.account(&participant_pda(&PID_B)).is_none());
}

#[test]
fn wrong_issuer_counterfeit_credential_fails() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    // Mallory runs her own SAS credential with an identical schema and badge.
    let mallory = env.new_wallet(90);
    let fake_cred = credential_pda(&mallory.pubkey(), CREDENTIAL_NAME);
    let fake_schema = schema_pda(&fake_cred, SCHEMA_NAME, 1);
    let ixs = vec![
        sas_create_credential(&env.payer.pubkey(), &mallory.pubkey(), CREDENTIAL_NAME, &[mallory.pubkey()]),
        sas_create_schema(&env.payer.pubkey(), &mallory.pubkey(), &fake_cred, &fake_schema),
        sas_tokenize_schema(&env.payer.pubkey(), &mallory.pubkey(), &fake_cred, &fake_schema, 10),
    ];
    ok(env.send(&ixs, &[&mallory]));
    let nonce = attestation_nonce(&PID_A, 1);
    let attestation = attestation_pda(&fake_cred, &fake_schema, &nonce);
    let data = ParticipantData {
        app_scope: APP_SCOPE.into(),
        participant_id: PID_A,
        wallet: alice.pubkey(),
        verification_method: 0,
        binding_version: 1,
        issued_at: env.now(),
    }
    .encode();
    let ix = sas_create_tokenized_attestation(
        &env.payer.pubkey(), &mallory.pubkey(), &fake_cred, &fake_schema, &attestation, &nonce,
        &alice.pubkey(), data, env.now() + DAY,
    );
    ok(env.send(&[ix], &[&mallory]));
    let mint = attestation_mint_pda(&attestation);
    let fake = Badge {
        participant_id: PID_A, binding_version: 1, wallet: alice.pubkey(), attestation, mint,
        token_account: ata(&alice.pubkey(), &mint), expiry: env.now() + DAY,
    };

    // Counterfeit attestation with the genuine credential/schema accounts.
    let ix = env.ix_register(&alice.pubkey(), PID_A, &fake);
    expect_err(env.send(&[ix], &[&alice]), "UntrustedCredential");

    // Counterfeit credential/schema accounts too.
    let mut ix = env.ix_register(&alice.pubkey(), PID_A, &fake);
    ix.accounts[5].pubkey = fake_cred;
    ix.accounts[6].pubkey = fake_schema;
    ix.accounts[7].pubkey = schema_mint_pda(&fake_schema);
    expect_err(env.send(&[ix], &[&alice]), "UntrustedCredential");
}

#[test]
fn unauthorized_signer_and_signer_rotation() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let badge = env.issue_badge(PID_A, &alice.pubkey(), 1);
    // Issuer key rotated out after issuance: badge no longer verifies.
    let other = Kp::new().pubkey();
    ok(env.set_authorized_signers(&[other]));
    expect_err(env.register(&alice, &badge), "UnauthorizedAttestationSigner");
}

#[test]
fn wrong_program_owner_and_forged_sas_accounts_fail() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let badge = env.issue_badge(PID_A, &alice.pubkey(), 1);

    // Attestation copied to an address owned by another program.
    let forged = env.clone_account(&badge.attestation, Some(consumer_id()), |_| {});
    let mut b = badge.clone();
    b.attestation = forged;
    expect_err(env.register(&alice, &b), "SasWrongOwner");

    // Same bytes, SAS-owned, but not at the canonical PDA.
    let forged = env.clone_account(&badge.attestation, None, |_| {});
    let mut b = badge.clone();
    b.attestation = forged;
    expect_err(env.register(&alice, &b), "NonCanonicalAttestation");

    // Credential with the wrong discriminator.
    let schema_copy = env.schema;
    let mut ix = env.ix_register(&alice.pubkey(), PID_A, &badge);
    ix.accounts[5].pubkey = schema_copy;
    expect_err(env.send(&[ix], &[&alice]), "UntrustedCredential");
}

#[test]
fn wrong_wallet_network_scope_and_method_in_payload_fail() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let now = env.now();
    let mut payload = ParticipantData {
        app_scope: "learned-markets:prod".into(),
        participant_id: PID_A,
        wallet: alice.pubkey(),
        verification_method: 0,
        binding_version: 1,
        issued_at: now,
    };
    let b = env.issue_badge_with(PID_A, &alice.pubkey(), 1, now, now + DAY, Some(payload.encode())).unwrap();
    expect_err(env.register(&alice, &b), "WrongAppScope");

    payload.app_scope = APP_SCOPE.into();
    payload.verification_method = 7;
    let b = env.issue_badge_with(PID_B, &alice.pubkey(), 1, now, now + DAY,
        Some(ParticipantData { participant_id: PID_B, ..payload.clone() }.encode())).unwrap();
    expect_err(env.register(&alice, &b), "UnsupportedVerificationMethod");

    // Payload names a different wallet than the badge holder.
    let pid_c = [0xC3; 32];
    let carol = env.new_wallet(12);
    let b = env.issue_badge_with(pid_c, &alice.pubkey(), 1, now, now + DAY,
        Some(ParticipantData { participant_id: pid_c, wallet: carol.pubkey(), verification_method: 0, ..payload.clone() }.encode())).unwrap();
    expect_err(env.register(&alice, &b), "WalletMismatch");
    let mut b2 = b.clone();
    b2.wallet = carol.pubkey();
    expect_err(env.register(&carol, &b2), "BadgeTokenAccountMismatch");

    // Malformed participant_id length passes SAS type validation but not ours.
    let pid_d = [0xD4; 32];
    let mut bad = Vec::new();
    bad.extend_from_slice(&(APP_SCOPE.len() as u32).to_le_bytes());
    bad.extend_from_slice(APP_SCOPE.as_bytes());
    bad.extend_from_slice(&31u32.to_le_bytes());
    bad.extend_from_slice(&[1u8; 31]);
    bad.extend_from_slice(&32u32.to_le_bytes());
    bad.extend_from_slice(alice.pubkey().as_ref());
    bad.push(0);
    bad.extend_from_slice(&1u32.to_le_bytes());
    bad.extend_from_slice(&now.to_le_bytes());
    let b = env.issue_badge_with(pid_d, &alice.pubkey(), 1, now, now + DAY, Some(bad)).unwrap();
    expect_err(env.register(&alice, &b), "MalformedAttestationData");
}

#[test]
fn expiry_rules() {
    let mut env = Env::new();
    let now = env.now();
    let w = env.new_wallet(10);

    // Non-expiring (SAS allows expiry = 0; we do not).
    let b = env.issue_badge_with([1; 32], &w.pubkey(), 1, now, 0, None).unwrap();
    expect_err(env.register(&w, &b), "NonExpiringAttestation");

    let w2 = env.new_wallet(11);
    let b = env.issue_badge_with([2; 32], &w2.pubkey(), 1, now, now + 7 * DAY + 1, None).unwrap();
    expect_err(env.register(&w2, &b), "AttestationLifetimeTooLong");

    let w3 = env.new_wallet(12);
    let b = env.issue_badge_with([3; 32], &w3.pubkey(), 1, now + 31, now + DAY, None).unwrap();
    expect_err(env.register(&w3, &b), "AttestationIssuedInFuture");

    let w4 = env.new_wallet(13);
    let b = env.issue_badge_with([4; 32], &w4.pubkey(), 1, now + 30, now + DAY, None).unwrap();
    ok(env.register(&w4, &b));

    let w5 = env.new_wallet(14);
    let b = env.issue_badge_with([5; 32], &w5.pubkey(), 1, now, now + 100, None).unwrap();
    env.advance(100);
    expect_err(env.register(&w5, &b), "AttestationExpired");
}

#[test]
fn schema_pause_and_admission_pause_block_admission() {
    let mut env = Env::new();
    let w = env.new_wallet(10);
    let b = env.issue_badge(PID_A, &w.pubkey(), 1);
    ok(env.set_schema_paused(true));
    expect_err(env.register(&w, &b), "AdmissionSuspended");
    ok(env.set_schema_paused(false));

    let admin = env.admin.insecure_clone();
    let ix = env.ix_update_config(&admin.pubkey(), Some(true), None);
    ok(env.send(&[ix], &[&admin]));
    expect_err(env.register(&w, &b), "AdmissionSuspended");
    let ix = env.ix_update_config(&admin.pubkey(), Some(false), None);
    ok(env.send(&[ix], &[&admin]));
    ok(env.register(&w, &b));
}

#[test]
fn closed_and_burned_badges_fail() {
    // Closure (revocation through SAS).
    let Registered { mut env, alice, badge } = registered();
    ok(env.revoke_badge(&badge));
    expect_err(env.submit_trade(&alice, &badge, 0, &market()), "SasWrongOwner");

    // Burn by the holder.
    let Registered { mut env, alice, badge } = registered();
    let burn = token_burn(&badge.token_account, &badge.mint, &alice.pubkey(), 1);
    ok(env.send(&[burn], &[&alice]));
    expect_err(env.submit_trade(&alice, &badge, 0, &market()), "BadgeWrongSupply");
}

#[test]
fn counterfeit_badge_mints_fail() {
    let Registered { mut env, alice, badge } = registered();

    // Copy of the real mint at another Token-2022 address.
    let fake_mint = env.clone_account(&badge.mint, None, |_| {});
    let mut b = badge.clone();
    b.mint = fake_mint;
    expect_err(env.submit_trade(&alice, &b, 0, &market()), "NonCanonicalBadgeMint");

    // Real mint address but transferable (NonTransferable extension type erased).
    let mut env2 = Env::new();
    let w = env2.new_wallet(10);
    let b2 = env2.issue_badge(PID_A, &w.pubkey(), 1);
    env2.edit_account(&b2.mint, |d| {
        let mut o = 166;
        while o + 4 <= d.len() {
            let ty = u16::from_le_bytes([d[o], d[o + 1]]);
            let len = u16::from_le_bytes([d[o + 2], d[o + 3]]) as usize;
            if ty == 9 {
                d[o] = 0xff; // unknown extension type
                d[o + 1] = 0x7f;
            }
            o += 4 + len;
        }
    });
    expect_err(env2.register(&w, &b2), "BadgeTransferable");

    // Wrong supply (decimals/supply tampered).
    let mut env3 = Env::new();
    let w = env3.new_wallet(10);
    let b3 = env3.issue_badge(PID_A, &w.pubkey(), 1);
    env3.edit_account(&b3.mint, |d| d[36..44].copy_from_slice(&2u64.to_le_bytes()));
    expect_err(env3.register(&w, &b3), "BadgeWrongSupply");

    // Badge mint owned by the legacy token program.
    let mut env4 = Env::new();
    let w = env4.new_wallet(10);
    let b4 = env4.issue_badge(PID_A, &w.pubkey(), 1);
    let mut acct = env4.svm.get_account(&b4.mint).unwrap();
    acct.owner = pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    env4.svm.set_account(b4.mint, acct).unwrap();
    expect_err(env4.register(&w, &b4), "BadgeWrongTokenProgram");
}

#[test]
fn missing_accounts_fail() {
    let Registered { mut env, alice, badge } = registered();
    let mut ix = env.ix_submit_raw(&alice.pubkey(), &PID_A, &badge, 0, KIND_TRADE, &market(), [0; 32], env.now() + 60);
    ix.accounts.truncate(8);
    expect_fail(env.send(&[ix], &[&alice]));
}

// ---------------------------------------------------------------- intents

#[test]
fn unapproved_wallet_cannot_submit_directly() {
    let Registered { mut env, badge, .. } = registered();
    let mallory = env.new_wallet(90);
    // Mallory has no binding: the binding PDA does not exist.
    let ix = env.ix_submit_raw(&mallory.pubkey(), &PID_A, &badge, 0, KIND_TRADE, &market(), [1; 32], env.now() + 60);
    expect_fail(env.send(&[ix], &[&mallory]));
    assert_eq!(env.participant(&PID_A).next_intent_nonce, 0);
}

#[test]
fn unapproved_wallet_cannot_submit_through_cpi() {
    let Registered { mut env, alice, badge } = registered();
    let mallory = env.new_wallet(90);

    let proxy = |env: &Env, wallet: &Address, nonce: u64| -> Instruction {
        let inner = env.ix_submit_raw(wallet, &PID_A, &badge, nonce, KIND_TRADE, &market(), [1; 32], env.now() + 60);
        let mut accounts = inner.accounts.clone();
        // ProxySubmitIntent layout: wallet, config, participant, binding, 6 badge, intent, gate_program, system
        let system = accounts.pop().unwrap();
        accounts.push(AccountMeta::new_readonly(lm_id(), false));
        accounts.push(system);
        let mut data = sha256(&[b"global:proxy_submit_intent"])[..8].to_vec();
        data.extend_from_slice(&inner.data[8..]);
        Instruction { program_id: consumer_id(), accounts, data }
    };

    let ix = proxy(&env, &mallory.pubkey(), 0);
    expect_fail(env.send(&[ix], &[&mallory]));
    assert_eq!(env.participant(&PID_A).next_intent_nonce, 0);

    // Mallory's own binding PDA does not exist; substituting Alice's binding
    // with Mallory as signer is rejected by the seeds check.
    let mut ix = proxy(&env, &mallory.pubkey(), 0);
    ix.accounts[3].pubkey = wallet_binding_pda(&alice.pubkey());
    expect_fail(env.send(&[ix], &[&mallory]));

    // CPI is not itself a bypass, nor a block: the bound wallet may automate.
    let ix = proxy(&env, &alice.pubkey(), 0);
    ok(env.send(&[ix], &[&alice]));
    assert_eq!(env.participant(&PID_A).next_intent_nonce, 1);
}

#[test]
fn fake_registry_accounts_fail() {
    let Registered { mut env, alice, badge } = registered();
    let ix0 = env.ix_submit_raw(&alice.pubkey(), &PID_A, &badge, 0, KIND_TRADE, &market(), [1; 32], env.now() + 60);

    // Config copied to a non-canonical address (program-owned).
    let fake_cfg = env.clone_account(&config_pda(), None, |_| {});
    let mut ix = ix0.clone();
    ix.accounts[1].pubkey = fake_cfg;
    expect_fail(env.send(&[ix], &[&alice]));

    // Config-shaped account owned by another program at a fresh address.
    let fake_cfg = env.clone_account(&config_pda(), Some(consumer_id()), |_| {});
    let mut ix = ix0.clone();
    ix.accounts[1].pubkey = fake_cfg;
    expect_fail(env.send(&[ix], &[&alice]));

    // Participant record substituted: a forged copy pointing at Mallory's wallet.
    let mallory = env.new_wallet(90);
    let fake_participant = env.clone_account(&participant_pda(&PID_A), None, |d| {
        d[8 + 2 + 32..8 + 2 + 64].copy_from_slice(mallory.pubkey().as_ref());
    });
    let mut ix = env.ix_submit_raw(&mallory.pubkey(), &PID_A, &badge, 0, KIND_TRADE, &market(), [1; 32], env.now() + 60);
    ix.accounts[2].pubkey = fake_participant;
    expect_fail(env.send(&[ix], &[&mallory]));

    // Valid submission still works afterwards.
    ok(env.send(&[ix0], &[&alice]));
}

#[test]
fn nonce_rules() {
    let Registered { mut env, alice, badge } = registered();
    ok(env.submit_trade(&alice, &badge, 0, &market()));
    // Replay of nonce 0.
    expect_fail(env.submit_trade(&alice, &badge, 0, &market()));
    // Skipping ahead.
    expect_err(env.submit_trade(&alice, &badge, 5, &market()), "WrongIntentNonce");
    ok(env.submit_trade(&alice, &badge, 1, &market()));
    // Cancellation does not reset the nonce.
    ok(env.cancel(&alice, &PID_A, 1));
    assert_eq!(env.participant(&PID_A).next_intent_nonce, 2);
    expect_fail(env.submit_trade(&alice, &badge, 1, &market()));
}

#[test]
fn deadline_rules() {
    let Registered { mut env, alice, badge } = registered();
    let now = env.now();
    let mk = |env: &Env, deadline: i64| {
        env.ix_submit_raw(&alice.pubkey(), &PID_A, &badge, 0, KIND_TRADE, &market(), [1; 32], deadline)
    };
    let ix = mk(&env, now);
    expect_err(env.send(&[ix], &[&alice]), "InvalidIntentDeadline");
    let ix = mk(&env, now + 301);
    expect_err(env.send(&[ix], &[&alice]), "InvalidIntentDeadline");
    let ix = mk(&env, now + 300);
    ok(env.send(&[ix], &[&alice]));

    // Deadline may not outlive the credential.
    let mut env = Env::new();
    let w = env.new_wallet(10);
    let now = env.now();
    let b = env.issue_badge_with(PID_A, &w.pubkey(), 1, now, now + 120, None).unwrap();
    ok(env.register(&w, &b));
    let ix = env.ix_submit_raw(&w.pubkey(), &PID_A, &b, 0, KIND_TRADE, &market(), [1; 32], now + 121);
    expect_err(env.send(&[ix], &[&w]), "InvalidIntentDeadline");
    let ix = env.ix_submit_raw(&w.pubkey(), &PID_A, &b, 0, KIND_TRADE, &market(), [1; 32], now + 120);
    ok(env.send(&[ix], &[&w]));
}

#[test]
fn nominations_are_gated_too() {
    let Registered { mut env, alice, badge } = registered();
    let mut contents = vec![1u8];
    contents.extend_from_slice(&[7u8; 32]);
    let slot = Address::new_from_array([0x55; 32]);
    let hash = payload_hash(NETWORK, KIND_NOMINATION, &slot, &contents);
    let ix = env.ix_submit_raw(&alice.pubkey(), &PID_A, &badge, 0, KIND_NOMINATION, &slot, hash, env.now() + 60);
    ok(env.send(&[ix], &[&alice]));
    let i = env.intent(&PID_A, 0);
    assert_eq!(i.kind, KIND_NOMINATION);
    assert_eq!(i.payload_hash, hash);

    // Suspended participants cannot nominate.
    ok(env.suspend(&PID_A));
    let ix = env.ix_submit_raw(&alice.pubkey(), &PID_A, &badge, 1, KIND_NOMINATION, &slot, hash, env.now() + 60);
    expect_err(env.send(&[ix], &[&alice]), "ParticipantNotActive");
}

#[test]
fn cancellation_survives_expiry_pause_suspension_and_revocation() {
    let Registered { mut env, alice, badge } = registered();
    for n in 0..4 {
        ok(env.submit_trade(&alice, &badge, n, &market()));
    }
    // Admission paused (config + schema).
    let admin = env.admin.insecure_clone();
    let ix = env.ix_update_config(&admin.pubkey(), Some(true), None);
    ok(env.send(&[ix], &[&admin]));
    ok(env.set_schema_paused(true));
    ok(env.cancel(&alice, &PID_A, 0));
    // Credential expired.
    env.advance(8 * DAY);
    ok(env.cancel(&alice, &PID_A, 1));
    // Suspended, then revoked.
    ok(env.suspend(&PID_A));
    ok(env.cancel(&alice, &PID_A, 2));
    ok(env.revoke_participant(&PID_A));
    ok(env.cancel(&alice, &PID_A, 3));
    for n in 0..4 {
        assert_eq!(env.intent(&PID_A, n).state, IntentState::Cancelled);
    }
    // Double cancel and cancel by a stranger fail.
    expect_err(env.cancel(&alice, &PID_A, 0), "IntentNotOpen");
    let mallory = env.new_wallet(90);
    expect_err(env.cancel(&mallory, &PID_A, 0), "WalletNotCurrent");
}

// ---------------------------------------------------------------- lifecycle

#[test]
fn suspension_and_revocation_deny_new_actions() {
    let Registered { mut env, alice, badge } = registered();
    let mallory = env.new_wallet(90);
    let ix = env.ix_set_status("suspend_participant", &mallory.pubkey(), &PID_A);
    expect_err(env.send(&[ix], &[&mallory]), "NotAdmin");

    ok(env.suspend(&PID_A));
    expect_err(env.submit_trade(&alice, &badge, 0, &market()), "ParticipantNotActive");
    ok(env.revoke_participant(&PID_A));
    expect_err(env.submit_trade(&alice, &badge, 0, &market()), "ParticipantRevoked");
    expect_err(env.revoke_participant(&PID_A), "ParticipantRevoked");
}

#[test]
fn wallet_replacement_preserves_identity_and_invalidates_old_binding() {
    let Registered { mut env, alice, badge } = registered();
    ok(env.submit_trade(&alice, &badge, 0, &market()));
    ok(env.submit_trade(&alice, &badge, 1, &market()));

    let bob = env.new_wallet(11);
    let badge2 = env.issue_badge(PID_A, &bob.pubkey(), 2);

    // Must be suspended first.
    expect_err(env.replace(&bob, Some(&alice.pubkey()), &badge2), "ParticipantNotSuspended");
    ok(env.suspend(&PID_A));
    ok(env.revoke_badge(&badge));

    // Requires the admin.
    let mallory = env.new_wallet(90);
    let ix = env.ix_replace(&mallory.pubkey(), &bob.pubkey(), Some(&alice.pubkey()), &badge2);
    expect_err(env.send(&[ix], &[&mallory, &bob]), "NotAdmin");
    // Requires the new wallet's signature.
    let admin = env.admin.insecure_clone();
    let mut ix = env.ix_replace(&admin.pubkey(), &bob.pubkey(), Some(&alice.pubkey()), &badge2);
    ix.accounts[2].is_signer = false;
    expect_fail(env.send(&[ix], &[&admin]));
    // Old binding must be provided when the wallet changes.
    expect_err(env.replace(&bob, None, &badge2), "WalletBindingMismatch");

    ok(env.replace(&bob, Some(&alice.pubkey()), &badge2));
    let p = env.participant(&PID_A);
    assert_eq!(p.current_wallet, bob.pubkey());
    assert_eq!(p.binding_version, 2);
    assert_eq!(p.status, ParticipantStatus::Active);
    assert_eq!(p.next_intent_nonce, 2, "nonce sequence preserved");
    assert!(!env.binding(&alice.pubkey()).active);
    assert!(env.binding(&bob.pubkey()).active);

    // Old wallet and old attestation are dead.
    expect_fail(env.submit_trade(&alice, &badge, 2, &market()));
    expect_err(env.submit_trade(&bob, &badge, 2, &market()), "AttestationNotCurrent");
    expect_err(env.cancel(&alice, &PID_A, 0), "WalletNotCurrent");
    // Intents from binding v1 are stale at settlement and must be re-signed.
    expect_err(
        env.settle_one(&PID_A, 0, &bob.pubkey(), &badge2, &market(), sample_trade()),
        "StaleIntentBinding",
    );
    // The new wallet can cancel intents the participant owns, and submit at nonce 2.
    ok(env.cancel(&bob, &PID_A, 1));
    expect_fail(env.submit_trade(&bob, &badge2, 0, &market())); // intent PDA exists
    expect_err(env.submit_trade(&bob, &badge2, 3, &market()), "WrongIntentNonce");
    ok(env.submit_trade(&bob, &badge2, 2, &market()));

    // Old wallet can never register as a different participant.
    let badge_b = env.issue_badge(PID_B, &alice.pubkey(), 1);
    expect_fail(env.register(&alice, &badge_b));
}

#[test]
fn replacement_version_and_ownership_rules() {
    let Registered { mut env, alice, badge } = registered();
    let other = env.new_wallet(12);
    let badge_other = env.issue_badge(PID_B, &other.pubkey(), 1);
    ok(env.register(&other, &badge_other));
    ok(env.suspend(&PID_A));

    // Skipping a version.
    let bob = env.new_wallet(11);
    let badge3 = env.issue_badge(PID_A, &bob.pubkey(), 3);
    expect_err(env.replace(&bob, Some(&alice.pubkey()), &badge3), "BindingVersionMismatch");

    // Replaying the current attestation (same version).
    expect_err(env.replace(&alice, None, &badge), "BindingVersionMismatch");

    // Another participant's badge.
    let carol = env.new_wallet(13);
    let badge_b2 = env.issue_badge(PID_B, &carol.pubkey(), 2);
    let admin = env.admin.insecure_clone();
    let mut ix = env.ix_replace(&admin.pubkey(), &carol.pubkey(), Some(&alice.pubkey()), &badge_b2);
    ix.accounts[4].pubkey = participant_pda(&PID_A);
    expect_err(env.send(&[ix], &[&admin, &carol]), "ParticipantMismatch");

    // A wallet bound to another participant cannot be taken over.
    let badge_take = env.issue_badge(PID_A, &other.pubkey(), 2);
    expect_err(env.replace(&other, Some(&alice.pubkey()), &badge_take), "WalletBoundToOtherParticipant");
    assert!(env.binding(&other.pubkey()).active);

    // Revoked participants cannot be replaced.
    ok(env.revoke_participant(&PID_A));
    let dave = env.new_wallet(14);
    let badge_d = env.issue_badge(PID_A, &dave.pubkey(), 4);
    expect_err(env.replace(&dave, Some(&alice.pubkey()), &badge_d), "ParticipantRevoked");
}

#[test]
fn same_wallet_renewal() {
    let Registered { mut env, alice, badge } = registered();
    ok(env.submit_trade(&alice, &badge, 0, &market()));
    env.advance(6 * DAY);
    ok(env.suspend(&PID_A));
    ok(env.revoke_badge(&badge));
    let renewed = env.issue_badge(PID_A, &alice.pubkey(), 2);
    // Supplying the same binding twice is rejected (Anchor duplicate-mutable check).
    let f = expect_fail(env.replace(&alice, Some(&alice.pubkey()), &renewed));
    assert_eq!(f.custom_code(), Some(2040), "ConstraintDuplicateMutableAccount");
    ok(env.replace(&alice, None, &renewed));
    let p = env.participant(&PID_A);
    assert_eq!(p.binding_version, 2);
    assert_eq!(p.next_intent_nonce, 1);
    assert!(env.binding(&alice.pubkey()).active);
    env.advance(2 * DAY); // past the first badge's expiry
    ok(env.submit_trade(&alice, &renewed, 1, &market()));
}

#[test]
fn duplicate_issuance_of_a_binding_version_is_impossible() {
    let mut env = Env::new();
    let w = env.new_wallet(10);
    env.issue_badge(PID_A, &w.pubkey(), 1);
    let w2 = env.new_wallet(11);
    let now = env.now();
    // Same (participant, version) → same deterministic SAS address → rejected by SAS.
    expect_fail(env.issue_badge_with(PID_A, &w2.pubkey(), 1, now, now + DAY, None));
}

// ---------------------------------------------------------------- settlement

#[test]
fn settlement_stub_validates_but_never_consumes_or_transfers() {
    let Registered { mut env, alice, badge } = registered();
    ok(env.submit_trade(&alice, &badge, 0, &market()));
    let intent = intent_pda(&participant_pda(&PID_A), 0);
    let watched = [intent, alice.pubkey(), participant_pda(&PID_A), badge.token_account, config_pda()];
    let before: Vec<_> = watched.iter().map(|a| env.svm.get_account(a).unwrap()).collect();

    let r = env.settle_one(&PID_A, 0, &alice.pubkey(), &badge, &market(), sample_trade());
    expect_err(r, "SettlementNotImplemented");

    let after: Vec<_> = watched.iter().map(|a| env.svm.get_account(a).unwrap()).collect();
    assert_eq!(before, after, "no state or lamport change");
    assert_eq!(env.intent(&PID_A, 0).state, IntentState::Open);

    // Only the settlement authority may call it.
    let mallory = env.new_wallet(90);
    let req = env.settle_request(&market(), 1, &[(intent, sample_trade())]);
    let mut ix = env.ix_settle(req, env.settle_intent_metas(&PID_A, 0, &alice.pubkey(), &badge));
    ix.accounts[0].pubkey = mallory.pubkey();
    expect_err(env.send(&[ix], &[&mallory]), "NotSettlementAuthority");
}

#[test]
fn settlement_validation_rejects_bad_intents() {
    let Registered { mut env, alice, badge } = registered();
    for n in 0..3 {
        ok(env.submit_trade(&alice, &badge, n, &market()));
    }
    let a = alice.pubkey();

    // Modified payload.
    let modified = trade_contents(0, &[(100, 5_001), (120, 2_000), (150, 0)]);
    expect_err(env.settle_one(&PID_A, 0, &a, &badge, &market(), modified), "PayloadHashMismatch");
    // Non-canonical payload.
    let bad = trade_contents(0, &[(120, 5_000), (100, 2_000)]);
    expect_err(env.settle_one(&PID_A, 0, &a, &badge, &market(), bad), "MalformedPayload");
    // Wrong market.
    let other = Address::new_from_array([9; 32]);
    expect_err(env.settle_one(&PID_A, 0, &a, &badge, &other, sample_trade()), "IntentTargetMismatch");
    // Cancelled intent.
    ok(env.cancel(&alice, &PID_A, 1));
    expect_err(env.settle_one(&PID_A, 1, &a, &badge, &market(), sample_trade()), "IntentNotOpen");
    // Same intent twice in one batch.
    let intent0 = intent_pda(&participant_pda(&PID_A), 0);
    let req = env.settle_request(&market(), 1, &[(intent0, sample_trade()), (intent0, sample_trade())]);
    let mut metas = env.settle_intent_metas(&PID_A, 0, &a, &badge);
    metas.extend(env.settle_intent_metas(&PID_A, 0, &a, &badge));
    let ix = env.ix_settle(req, metas);
    let sa = env.settlement_authority.insecure_clone();
    expect_err(env.send(&[ix], &[&sa]), "DuplicateSettlementIntent");
    // Omitted gate accounts.
    let req = env.settle_request(&market(), 1, &[(intent0, sample_trade())]);
    let mut metas = env.settle_intent_metas(&PID_A, 0, &a, &badge);
    metas.truncate(5);
    let ix = env.ix_settle(req, metas);
    expect_err(env.send(&[ix], &[&sa]), "SettlementAccountsMismatch");
    // Expired intent.
    env.advance(61);
    expect_err(env.settle_one(&PID_A, 2, &a, &badge, &market(), sample_trade()), "IntentExpired");
}

#[test]
fn eligibility_is_rechecked_at_settlement() {
    // Suspension after admission.
    let Registered { mut env, alice, badge } = registered();
    ok(env.submit_trade(&alice, &badge, 0, &market()));
    ok(env.suspend(&PID_A));
    expect_err(
        env.settle_one(&PID_A, 0, &alice.pubkey(), &badge, &market(), sample_trade()),
        "ParticipantNotActive",
    );

    // Badge revoked through SAS after admission.
    let Registered { mut env, alice, badge } = registered();
    ok(env.submit_trade(&alice, &badge, 0, &market()));
    ok(env.revoke_badge(&badge));
    expect_err(
        env.settle_one(&PID_A, 0, &alice.pubkey(), &badge, &market(), sample_trade()),
        "SasWrongOwner",
    );

    // Admission pauses do not block settlement of admitted intents (Standing mode).
    let Registered { mut env, alice, badge } = registered();
    ok(env.submit_trade(&alice, &badge, 0, &market()));
    ok(env.set_schema_paused(true));
    expect_err(
        env.settle_one(&PID_A, 0, &alice.pubkey(), &badge, &market(), sample_trade()),
        "SettlementNotImplemented",
    );
}

#[test]
fn settlement_consumer_cannot_omit_or_substitute_gate_accounts() {
    let Registered { mut env, alice, badge } = registered();
    ok(env.submit_trade(&alice, &badge, 0, &market()));
    let intent0 = intent_pda(&participant_pda(&PID_A), 0);
    let sa = env.settlement_authority.insecure_clone();

    let proxy = |env: &Env, config: Address, metas: Vec<AccountMeta>| -> Instruction {
        let mut accounts = vec![
            AccountMeta::new_readonly(sa.pubkey(), true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new_readonly(env.credential, false),
            AccountMeta::new_readonly(env.schema, false),
            AccountMeta::new_readonly(env.schema_mint, false),
            AccountMeta::new_readonly(lm_id(), false),
        ];
        accounts.extend(metas);
        let mut data = sha256(&[b"global:proxy_settle_batch"])[..8].to_vec();
        data.extend(env.settle_request(&market(), 7, &[(intent0, sample_trade())]));
        Instruction { program_id: consumer_id(), accounts, data }
    };
    let good = env.settle_intent_metas(&PID_A, 0, &alice.pubkey(), &badge);

    // Through CPI the full validation runs and reaches the stub.
    let ix = proxy(&env, config_pda(), good.clone());
    expect_err(env.send(&[ix], &[&sa]), "SettlementNotImplemented");

    // Substituted config (owned by the consumer).
    let fake_cfg = env.clone_account(&config_pda(), Some(consumer_id()), |_| {});
    let ix = proxy(&env, fake_cfg, good.clone());
    expect_fail(env.send(&[ix], &[&sa]));

    // Omitted per-intent gate accounts.
    let ix = proxy(&env, config_pda(), good[..3].to_vec());
    expect_err(env.send(&[ix], &[&sa]), "SettlementAccountsMismatch");

    // Substituted participant (another real, active participant).
    let bob = env.new_wallet(11);
    let badge_b = env.issue_badge(PID_B, &bob.pubkey(), 1);
    ok(env.register(&bob, &badge_b));
    let mut metas = good.clone();
    metas[1].pubkey = participant_pda(&PID_B);
    let ix = proxy(&env, config_pda(), metas);
    expect_err(env.send(&[ix], &[&sa]), "NonCanonicalRegistryAccount");

    // Substituted badge (Bob's valid badge for Alice's intent).
    let mut metas = good.clone();
    metas[3].pubkey = badge_b.attestation;
    metas[4].pubkey = badge_b.mint;
    metas[5].pubkey = badge_b.token_account;
    let ix = proxy(&env, config_pda(), metas);
    expect_err(env.send(&[ix], &[&sa]), "AttestationNotCurrent");

    // Substituted wallet binding (Bob's).
    let mut metas = good.clone();
    metas[2].pubkey = wallet_binding_pda(&bob.pubkey());
    let ix = proxy(&env, config_pda(), metas);
    expect_err(env.send(&[ix], &[&sa]), "WalletNotCurrent");

    // Forged intent account (program-owned copy at a non-canonical address).
    let forged = env.clone_account(&intent0, None, |_| {});
    let mut metas = good.clone();
    metas[0].pubkey = forged;
    let ix = proxy(&env, config_pda(), metas);
    expect_err(env.send(&[ix], &[&sa]), "SettlementAccountsMismatch");

    assert_eq!(env.intent(&PID_A, 0).state, IntentState::Open);
}
