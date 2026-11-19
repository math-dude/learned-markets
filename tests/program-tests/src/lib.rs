//! LiteSVM harness for the learned-markets gate.
//!
//! Loads the real Solana Attestation Service binary (dumped from devnet, see
//! `fixtures/README.md`), the bundled Token-2022 / ATA programs, and the
//! compiled `learned_markets.so` / `gate_test_consumer.so`. Instructions are
//! encoded here independently of the program crate; discriminators and error
//! codes come from the Anchor IDL so a drift between the two fails loudly.

use std::{collections::HashMap, path::PathBuf};

use borsh::{BorshDeserialize, BorshSerialize};
use litesvm::{types::TransactionMetadata, LiteSVM};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;

pub use solana_address::Address;
pub use solana_keypair::Keypair as Kp;
pub use solana_signer::Signer as _;

// ---------------------------------------------------------------------------
// Well-known addresses and constants (mirrors programs/learned-markets/src/constants.rs)
// ---------------------------------------------------------------------------

pub fn pk(s: &str) -> Pubkey {
    s.parse().unwrap()
}

pub fn lm_id() -> Pubkey {
    pk("nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz")
}
pub fn consumer_id() -> Pubkey {
    pk("ZwKZ5pjQuiEr6AbHCj4BibaCLfyagQj8Ye4nfHRRx4q")
}
pub fn sas_id() -> Pubkey {
    pk("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG")
}
pub fn token_2022_id() -> Pubkey {
    pk("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
}
pub fn ata_program_id() -> Pubkey {
    pk("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
}
pub fn system_id() -> Pubkey {
    Pubkey::default()
}
pub fn upgradeable_loader_id() -> Pubkey {
    pk("BPFLoaderUpgradeab1e11111111111111111111111")
}

pub const APP_SCOPE: &str = "learned-markets:demo";
pub const NETWORK: &str = "localnet";
pub const CREDENTIAL_NAME: &str = "Learned Markets Demo Issuer";
pub const SCHEMA_NAME: &str = "learned-markets-participant";
pub const SCHEMA_DESCRIPTION: &str =
    "Binds an operator-approved Learned Markets test participant to one wallet";
pub const SCHEMA_LAYOUT: [u8; 6] = [12, 13, 13, 0, 2, 8];
pub const SCHEMA_FIELDS: [&str; 6] = [
    "app_scope",
    "participant_id",
    "wallet",
    "verification_method",
    "binding_version",
    "issued_at",
];
pub const BADGE_NAME: &str = "Learned Markets Demo Pass";
pub const BADGE_SYMBOL: &str = "LMTEST";
pub const BADGE_URI: &str = "https://badges.learned-markets.test/v1/badge/metadata.json";
pub const SCHEMA_GROUP_MAX_SIZE: u64 = 1_000_000;
pub const DAY: i64 = 86_400;
pub const START_TIME: i64 = 1_763_600_000;

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn find(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

// SAS PDAs
pub fn credential_pda(authority: &Pubkey, name: &str) -> Pubkey {
    find(&[b"credential", authority.as_ref(), name.as_bytes()], &sas_id())
}
pub fn schema_pda(credential: &Pubkey, name: &str, version: u8) -> Pubkey {
    find(&[b"schema", credential.as_ref(), name.as_bytes(), &[version]], &sas_id())
}
pub fn attestation_pda(credential: &Pubkey, schema: &Pubkey, nonce: &Pubkey) -> Pubkey {
    find(&[b"attestation", credential.as_ref(), schema.as_ref(), nonce.as_ref()], &sas_id())
}
pub fn schema_mint_pda(schema: &Pubkey) -> Pubkey {
    find(&[b"schemaMint", schema.as_ref()], &sas_id())
}
pub fn attestation_mint_pda(attestation: &Pubkey) -> Pubkey {
    find(&[b"attestationMint", attestation.as_ref()], &sas_id())
}
pub fn sas_authority_pda() -> Pubkey {
    find(&[b"sas"], &sas_id())
}
pub fn sas_event_authority_pda() -> Pubkey {
    find(&[b"__event_authority"], &sas_id())
}
pub fn ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    find(&[wallet.as_ref(), token_2022_id().as_ref(), mint.as_ref()], &ata_program_id())
}

pub fn attestation_nonce(participant_id: &[u8; 32], binding_version: u32) -> Pubkey {
    Pubkey::new_from_array(sha256(&[
        b"learned-markets:attestation-nonce:v1",
        participant_id,
        &binding_version.to_le_bytes(),
    ]))
}

// Gate PDAs
pub fn config_pda() -> Pubkey {
    find(&[b"config"], &lm_id())
}
pub fn participant_pda(participant_id: &[u8; 32]) -> Pubkey {
    find(&[b"participant", APP_SCOPE.as_bytes(), participant_id], &lm_id())
}
pub fn wallet_binding_pda(wallet: &Pubkey) -> Pubkey {
    find(&[b"wallet-binding", wallet.as_ref()], &lm_id())
}
pub fn intent_pda(participant: &Pubkey, nonce: u64) -> Pubkey {
    find(&[b"intent", participant.as_ref(), &nonce.to_le_bytes()], &lm_id())
}

// ---------------------------------------------------------------------------
// Attestation payload and intent payloads (independent re-implementation)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ParticipantData {
    pub app_scope: String,
    pub participant_id: [u8; 32],
    pub wallet: Pubkey,
    pub verification_method: u8,
    pub binding_version: u32,
    pub issued_at: i64,
}

impl ParticipantData {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(self.app_scope.len() as u32).to_le_bytes());
        out.extend_from_slice(self.app_scope.as_bytes());
        out.extend_from_slice(&32u32.to_le_bytes());
        out.extend_from_slice(&self.participant_id);
        out.extend_from_slice(&32u32.to_le_bytes());
        out.extend_from_slice(self.wallet.as_ref());
        out.push(self.verification_method);
        out.extend_from_slice(&self.binding_version.to_le_bytes());
        out.extend_from_slice(&self.issued_at.to_le_bytes());
        out
    }
}

pub const KIND_TRADE: u8 = 0;
pub const KIND_NOMINATION: u8 = 1;

pub fn payload_hash(network: &str, kind: u8, target: &Pubkey, contents: &[u8]) -> [u8; 32] {
    let domain: &[u8] = b"learned-markets:intent-payload";
    sha256(&[
        &(domain.len() as u32).to_le_bytes(),
        domain,
        &[1u8],
        &(APP_SCOPE.len() as u32).to_le_bytes(),
        APP_SCOPE.as_bytes(),
        &(network.len() as u32).to_le_bytes(),
        network.as_bytes(),
        &[kind],
        target.as_ref(),
        &(contents.len() as u32).to_le_bytes(),
        contents,
    ])
}

/// Canonical buy curve: (price, quantity) points, prices ascending.
pub fn trade_contents(side: u8, points: &[(u64, u64)]) -> Vec<u8> {
    let mut out = vec![1u8, side, points.len() as u8];
    for (p, q) in points {
        out.extend_from_slice(&p.to_le_bytes());
        out.extend_from_slice(&q.to_le_bytes());
    }
    out
}

pub fn sample_trade() -> Vec<u8> {
    trade_contents(0, &[(100, 5_000), (120, 2_000), (150, 0)])
}

// ---------------------------------------------------------------------------
// Account mirrors (borsh, after the 8-byte Anchor discriminator)
// ---------------------------------------------------------------------------

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub app_scope: String,
    pub network: String,
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub sas_program: Pubkey,
    pub sas_authority: Pubkey,
    pub credential: Pubkey,
    pub credential_authority: Pubkey,
    pub schema: Pubkey,
    pub schema_version: u8,
    pub schema_mint: Pubkey,
    pub allowed_verification_method: u8,
    pub admission_paused: bool,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParticipantStatus {
    Active,
    Suspended,
    Revoked,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub struct Participant {
    pub version: u8,
    pub bump: u8,
    pub participant_id: [u8; 32],
    pub current_wallet: Pubkey,
    pub current_attestation: Pubkey,
    pub current_badge_mint: Pubkey,
    pub binding_version: u32,
    pub status: ParticipantStatus,
    pub next_intent_nonce: u64,
    pub registered_at: i64,
    pub updated_at: i64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub struct WalletBinding {
    pub version: u8,
    pub bump: u8,
    pub wallet: Pubkey,
    pub participant: Pubkey,
    pub participant_id: [u8; 32],
    pub active: bool,
    pub bound_at: i64,
    pub retired_at: i64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentState {
    Open,
    Cancelled,
    Consumed,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub struct Intent {
    pub version: u8,
    pub bump: u8,
    pub participant: Pubkey,
    pub wallet: Pubkey,
    pub binding_version: u32,
    pub nonce: u64,
    pub kind: u8,
    pub target: Pubkey,
    pub payload_hash: [u8; 32],
    pub created_at: i64,
    pub deadline: i64,
    pub state: IntentState,
}

// ---------------------------------------------------------------------------
// IDL-derived discriminators and error codes
// ---------------------------------------------------------------------------

pub struct Idl {
    pub ix: HashMap<String, Vec<u8>>,
    pub accounts: HashMap<String, Vec<u8>>,
    pub errors: HashMap<String, u32>,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn load_idl(name: &str) -> Idl {
    let path = repo_root().join(format!("target/idl/{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("missing {path:?}; run `anchor build` first"));
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let disc = |x: &serde_json::Value| -> Vec<u8> {
        x["discriminator"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect()
    };
    let mut ix = HashMap::new();
    for i in v["instructions"].as_array().unwrap() {
        ix.insert(i["name"].as_str().unwrap().to_string(), disc(i));
    }
    let mut accounts = HashMap::new();
    for a in v["accounts"].as_array().cloned().unwrap_or_default() {
        accounts.insert(a["name"].as_str().unwrap().to_string(), disc(&a));
    }
    let mut errors = HashMap::new();
    for e in v["errors"].as_array().cloned().unwrap_or_default() {
        errors.insert(
            e["name"].as_str().unwrap().to_string(),
            e["code"].as_u64().unwrap() as u32,
        );
    }
    Idl { ix, accounts, errors }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct TxFailure {
    pub err: TransactionError,
    pub logs: Vec<String>,
}

impl TxFailure {
    pub fn custom_code(&self) -> Option<u32> {
        match &self.err {
            TransactionError::InstructionError(_, solana_instruction::error::InstructionError::Custom(c)) => Some(*c),
            _ => None,
        }
    }
    pub fn logs_contain(&self, needle: &str) -> bool {
        self.logs.iter().any(|l| l.contains(needle))
    }
}

pub type TxResult = Result<TransactionMetadata, TxFailure>;

fn gate_errors() -> &'static HashMap<String, u32> {
    static ERRORS: std::sync::OnceLock<HashMap<String, u32>> = std::sync::OnceLock::new();
    ERRORS.get_or_init(|| load_idl("learned_markets").errors)
}

pub fn err_code(name: &str) -> u32 {
    *gate_errors().get(name).unwrap_or_else(|| panic!("unknown error {name}"))
}

/// Asserts the transaction failed with the named gate error.
#[track_caller]
pub fn expect_err<T>(res: Result<T, TxFailure>, name: &str) {
    match res {
        Ok(_) => panic!("expected {name}, transaction succeeded"),
        Err(f) => {
            let code = err_code(name);
            assert_eq!(
                f.custom_code(),
                Some(code),
                "expected {name} ({code}), got {:?}\nlogs:\n{}",
                f.err,
                f.logs.join("\n")
            );
        }
    }
}

#[track_caller]
pub fn expect_fail<T>(res: Result<T, TxFailure>) -> TxFailure {
    match res {
        Ok(_) => panic!("expected failure, transaction succeeded"),
        Err(f) => f,
    }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Badge {
    pub participant_id: [u8; 32],
    pub binding_version: u32,
    pub wallet: Pubkey,
    pub attestation: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub expiry: i64,
}

pub struct Env {
    pub svm: LiteSVM,
    pub idl: Idl,
    pub payer: Keypair,
    pub deployer: Keypair,
    pub admin: Keypair,
    pub settlement_authority: Keypair,
    pub credential_authority: Keypair,
    pub issuer_signer: Keypair,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub schema_mint: Pubkey,
}

pub fn keypair(seed: u8) -> Keypair {
    Keypair::new_from_array([seed; 32])
}

impl Env {
    /// Programs loaded and SAS issuer set up, gate config *not* initialized.
    pub fn bare() -> Self {
        let mut svm = LiteSVM::new();
        let root = repo_root();
        svm.add_program(
            sas_id(),
            &std::fs::read(root.join("tests/program-tests/fixtures/solana_attestation_service.so")).unwrap(),
        )
        .unwrap();
        svm.add_program(
            lm_id(),
            &std::fs::read(root.join("target/deploy/learned_markets.so")).expect("run anchor build"),
        )
        .unwrap();
        svm.add_program(
            consumer_id(),
            &std::fs::read(root.join("target/deploy/gate_test_consumer.so")).expect("run anchor build"),
        )
        .unwrap();

        let mut env = Env {
            svm,
            idl: load_idl("learned_markets"),
            payer: keypair(1),
            deployer: keypair(2),
            admin: keypair(3),
            settlement_authority: keypair(4),
            credential_authority: keypair(5),
            issuer_signer: keypair(6),
            credential: Pubkey::default(),
            schema: Pubkey::default(),
            schema_mint: Pubkey::default(),
        };
        env.set_time(START_TIME);
        for k in [&env.payer, &env.deployer, &env.admin, &env.settlement_authority, &env.credential_authority, &env.issuer_signer] {
            env.svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        env.set_upgrade_authority(&lm_id(), Some(env.deployer.pubkey()));

        // SAS issuer: credential, schema v1, tokenized schema group.
        let authority = env.credential_authority.pubkey();
        env.credential = credential_pda(&authority, CREDENTIAL_NAME);
        env.schema = schema_pda(&env.credential, SCHEMA_NAME, 1);
        env.schema_mint = schema_mint_pda(&env.schema);
        let ixs = vec![
            sas_create_credential(&env.payer.pubkey(), &authority, CREDENTIAL_NAME, &[env.issuer_signer.pubkey()]),
            sas_create_schema(&env.payer.pubkey(), &authority, &env.credential, &env.schema),
            sas_tokenize_schema(&env.payer.pubkey(), &authority, &env.credential, &env.schema, SCHEMA_GROUP_MAX_SIZE),
        ];
        let ca = env.credential_authority.insecure_clone();
        env.send(&ixs, &[&ca]).expect("SAS issuer setup");
        env
    }

    /// Fully initialized: SAS issuer + gate config.
    pub fn new() -> Self {
        let mut env = Self::bare();
        let deployer = env.deployer.insecure_clone();
        let ix = env.ix_initialize_config(&deployer.pubkey(), NETWORK);
        env.send(&[ix], &[&deployer]).expect("initialize_config");
        env
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_time(&mut self, unix: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    pub fn advance(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }

    pub fn set_upgrade_authority(&mut self, program: &Pubkey, authority: Option<Pubkey>) {
        let programdata = find(&[program.as_ref()], &upgradeable_loader_id());
        let mut acct = self.svm.get_account(&programdata).unwrap();
        match authority {
            Some(a) => {
                acct.data[12] = 1;
                acct.data[13..45].copy_from_slice(a.as_ref());
            }
            None => {
                acct.data[12] = 0;
                acct.data[13..45].fill(0);
            }
        }
        self.svm.set_account(programdata, acct).unwrap();
    }

    pub fn program_data(&self, program: &Pubkey) -> Pubkey {
        find(&[program.as_ref()], &upgradeable_loader_id())
    }

    pub fn send(&mut self, ixs: &[Instruction], extra_signers: &[&Keypair]) -> TxResult {
        self.svm.expire_blockhash();
        let payer = self.payer.insecure_clone();
        let mut signers: Vec<&Keypair> = vec![&payer];
        for s in extra_signers {
            if s.pubkey() != payer.pubkey() && !signers.iter().any(|x| x.pubkey() == s.pubkey()) {
                signers.push(s);
            }
        }
        let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
        self.svm
            .send_transaction(tx)
            .map_err(|f| TxFailure { err: f.err, logs: f.meta.logs })
    }

    pub fn account(&self, address: &Pubkey) -> Option<Account> {
        self.svm.get_account(address).filter(|a| a.lamports > 0)
    }

    pub fn decode<T: BorshDeserialize>(&self, name: &str, address: &Pubkey) -> T {
        let acct = self.account(address).unwrap_or_else(|| panic!("{name} {address} missing"));
        assert_eq!(acct.owner, lm_id());
        assert_eq!(&acct.data[..8], self.idl.accounts[name].as_slice(), "{name} discriminator");
        T::deserialize(&mut &acct.data[8..]).unwrap()
    }

    pub fn config(&self) -> Config {
        self.decode("Config", &config_pda())
    }
    pub fn participant(&self, id: &[u8; 32]) -> Participant {
        self.decode("Participant", &participant_pda(id))
    }
    pub fn binding(&self, wallet: &Pubkey) -> WalletBinding {
        self.decode("WalletBinding", &wallet_binding_pda(wallet))
    }
    pub fn intent(&self, participant_id: &[u8; 32], nonce: u64) -> Intent {
        self.decode("Intent", &intent_pda(&participant_pda(participant_id), nonce))
    }

    pub fn new_wallet(&mut self, seed: u8) -> Keypair {
        let k = keypair(seed);
        self.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        k
    }

    // ----------------------------------------------------------------- SAS ops

    pub fn issue_badge_with(
        &mut self,
        participant_id: [u8; 32],
        wallet: &Pubkey,
        binding_version: u32,
        issued_at: i64,
        expiry: i64,
        data_override: Option<Vec<u8>>,
    ) -> Result<Badge, TxFailure> {
        let data = data_override.unwrap_or_else(|| {
            ParticipantData {
                app_scope: APP_SCOPE.to_string(),
                participant_id,
                wallet: *wallet,
                verification_method: 0,
                binding_version,
                issued_at,
            }
            .encode()
        });
        let nonce = attestation_nonce(&participant_id, binding_version);
        let attestation = attestation_pda(&self.credential, &self.schema, &nonce);
        let mint = attestation_mint_pda(&attestation);
        let token_account = ata(wallet, &mint);
        let ix = sas_create_tokenized_attestation(
            &self.payer.pubkey(),
            &self.issuer_signer.pubkey(),
            &self.credential,
            &self.schema,
            &attestation,
            &nonce,
            wallet,
            data,
            expiry,
        );
        let signer = self.issuer_signer.insecure_clone();
        self.send(&[ix], &[&signer])?;
        Ok(Badge { participant_id, binding_version, wallet: *wallet, attestation, mint, token_account, expiry })
    }

    pub fn issue_badge(&mut self, participant_id: [u8; 32], wallet: &Pubkey, binding_version: u32) -> Badge {
        let now = self.now();
        self.issue_badge_with(participant_id, wallet, binding_version, now, now + 7 * DAY, None)
            .expect("issue badge")
    }

    pub fn revoke_badge(&mut self, badge: &Badge) -> TxResult {
        let ix = sas_close_tokenized_attestation(
            &self.payer.pubkey(),
            &self.issuer_signer.pubkey(),
            &self.credential,
            &badge.attestation,
            &badge.mint,
            &badge.token_account,
        );
        let signer = self.issuer_signer.insecure_clone();
        self.send(&[ix], &[&signer])
    }

    pub fn set_schema_paused(&mut self, paused: bool) -> TxResult {
        let ix = Instruction {
            program_id: sas_id(),
            accounts: vec![
                AccountMeta::new_readonly(self.credential_authority.pubkey(), true),
                AccountMeta::new_readonly(self.credential, false),
                AccountMeta::new(self.schema, false),
            ],
            data: vec![2, paused as u8],
        };
        let ca = self.credential_authority.insecure_clone();
        self.send(&[ix], &[&ca])
    }

    pub fn set_authorized_signers(&mut self, signers: &[Pubkey]) -> TxResult {
        let mut data = vec![3u8];
        data.extend_from_slice(&(signers.len() as u32).to_le_bytes());
        for s in signers {
            data.extend_from_slice(s.as_ref());
        }
        let ix = Instruction {
            program_id: sas_id(),
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(self.credential_authority.pubkey(), true),
                AccountMeta::new(self.credential, false),
                AccountMeta::new_readonly(system_id(), false),
            ],
            data,
        };
        let ca = self.credential_authority.insecure_clone();
        self.send(&[ix], &[&ca])
    }

    // ---------------------------------------------------------------- gate ixs

    fn ix_data<T: BorshSerialize>(&self, name: &str, args: &T) -> Vec<u8> {
        let mut data = self.idl.ix[name].clone();
        args.serialize(&mut data).unwrap();
        data
    }

    pub fn badge_metas(&self, badge: &Badge) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(self.credential, false),
            AccountMeta::new_readonly(self.schema, false),
            AccountMeta::new_readonly(self.schema_mint, false),
            AccountMeta::new_readonly(badge.attestation, false),
            AccountMeta::new_readonly(badge.mint, false),
            AccountMeta::new_readonly(badge.token_account, false),
        ]
    }

    pub fn ix_initialize_config(&self, authority: &Pubkey, network: &str) -> Instruction {
        #[derive(BorshSerialize)]
        struct Args {
            app_scope: String,
            network: String,
            admin: Pubkey,
            settlement_authority: Pubkey,
            credential_authority: Pubkey,
            schema_version: u8,
            allowed_verification_method: u8,
        }
        let args = Args {
            app_scope: APP_SCOPE.into(),
            network: network.into(),
            admin: self.admin.pubkey(),
            settlement_authority: self.settlement_authority.pubkey(),
            credential_authority: self.credential_authority.pubkey(),
            schema_version: 1,
            allowed_verification_method: 0,
        };
        Instruction {
            program_id: lm_id(),
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(*authority, true),
                AccountMeta::new_readonly(lm_id(), false),
                AccountMeta::new_readonly(self.program_data(&lm_id()), false),
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(self.credential, false),
                AccountMeta::new_readonly(self.schema, false),
                AccountMeta::new_readonly(system_id(), false),
            ],
            data: self.ix_data("initialize_config", &args),
        }
    }

    pub fn ix_update_config(
        &self,
        admin: &Pubkey,
        admission_paused: Option<bool>,
        new_admin: Option<Pubkey>,
    ) -> Instruction {
        let args = (admission_paused, new_admin, Option::<Pubkey>::None);
        Instruction {
            program_id: lm_id(),
            accounts: vec![
                AccountMeta::new_readonly(*admin, true),
                AccountMeta::new(config_pda(), false),
            ],
            data: self.ix_data("update_config", &args),
        }
    }

    pub fn ix_register(&self, wallet: &Pubkey, participant_id: [u8; 32], badge: &Badge) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new_readonly(*wallet, true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(participant_pda(&participant_id), false),
            AccountMeta::new(wallet_binding_pda(wallet), false),
        ];
        accounts.extend(self.badge_metas(badge));
        accounts.push(AccountMeta::new_readonly(system_id(), false));
        Instruction { program_id: lm_id(), accounts, data: self.ix_data("register_participant", &participant_id) }
    }

    pub fn register(&mut self, wallet: &Keypair, badge: &Badge) -> TxResult {
        let ix = self.ix_register(&wallet.pubkey(), badge.participant_id, badge);
        self.send(&[ix], &[wallet])
    }

    pub fn ix_set_status(&self, name: &str, admin: &Pubkey, participant_id: &[u8; 32]) -> Instruction {
        Instruction {
            program_id: lm_id(),
            accounts: vec![
                AccountMeta::new_readonly(*admin, true),
                AccountMeta::new_readonly(config_pda(), false),
                AccountMeta::new(participant_pda(participant_id), false),
            ],
            data: self.idl.ix[name].clone(),
        }
    }

    pub fn suspend(&mut self, participant_id: &[u8; 32]) -> TxResult {
        let admin = self.admin.insecure_clone();
        let ix = self.ix_set_status("suspend_participant", &admin.pubkey(), participant_id);
        self.send(&[ix], &[&admin])
    }

    pub fn revoke_participant(&mut self, participant_id: &[u8; 32]) -> TxResult {
        let admin = self.admin.insecure_clone();
        let ix = self.ix_set_status("revoke_participant", &admin.pubkey(), participant_id);
        self.send(&[ix], &[&admin])
    }

    pub fn ix_replace(
        &self,
        admin: &Pubkey,
        new_wallet: &Pubkey,
        old_wallet: Option<&Pubkey>,
        badge: &Badge,
    ) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new_readonly(*new_wallet, true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(participant_pda(&badge.participant_id), false),
            match old_wallet {
                Some(w) => AccountMeta::new(wallet_binding_pda(w), false),
                // Anchor encodes an omitted Option account as the program id.
                None => AccountMeta::new_readonly(lm_id(), false),
            },
            AccountMeta::new(wallet_binding_pda(new_wallet), false),
        ];
        accounts.extend(self.badge_metas(badge));
        accounts.push(AccountMeta::new_readonly(system_id(), false));
        Instruction { program_id: lm_id(), accounts, data: self.idl.ix["replace_binding"].clone() }
    }

    pub fn replace(&mut self, new_wallet: &Keypair, old_wallet: Option<&Pubkey>, badge: &Badge) -> TxResult {
        let admin = self.admin.insecure_clone();
        let ix = self.ix_replace(&admin.pubkey(), &new_wallet.pubkey(), old_wallet, badge);
        self.send(&[ix], &[&admin, new_wallet])
    }

    pub fn submit_metas(&self, wallet: &Pubkey, participant_id: &[u8; 32], badge: &Badge, nonce: u64) -> Vec<AccountMeta> {
        let participant = participant_pda(participant_id);
        let mut accounts = vec![
            AccountMeta::new(*wallet, true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(participant, false),
            AccountMeta::new_readonly(wallet_binding_pda(wallet), false),
        ];
        accounts.extend(self.badge_metas(badge));
        accounts.push(AccountMeta::new(intent_pda(&participant, nonce), false));
        accounts.push(AccountMeta::new_readonly(system_id(), false));
        accounts
    }

    pub fn submit_args(&self, nonce: u64, kind: u8, target: &Pubkey, payload_hash: [u8; 32], deadline: i64) -> Vec<u8> {
        let mut args = Vec::new();
        nonce.serialize(&mut args).unwrap();
        args.push(kind);
        args.extend_from_slice(target.as_ref());
        args.extend_from_slice(&payload_hash);
        deadline.serialize(&mut args).unwrap();
        args
    }

    pub fn ix_submit_raw(
        &self,
        wallet: &Pubkey,
        participant_id: &[u8; 32],
        badge: &Badge,
        nonce: u64,
        kind: u8,
        target: &Pubkey,
        payload_hash: [u8; 32],
        deadline: i64,
    ) -> Instruction {
        let mut data = self.idl.ix["submit_intent"].clone();
        data.extend(self.submit_args(nonce, kind, target, payload_hash, deadline));
        Instruction { program_id: lm_id(), accounts: self.submit_metas(wallet, participant_id, badge, nonce), data }
    }

    /// Submits a canonical trade intent for `market` with a 60 s deadline.
    pub fn submit_trade(&mut self, wallet: &Keypair, badge: &Badge, nonce: u64, market: &Pubkey) -> TxResult {
        let hash = payload_hash(NETWORK, KIND_TRADE, market, &sample_trade());
        let deadline = self.now() + 60;
        let ix = self.ix_submit_raw(&wallet.pubkey(), &badge.participant_id, badge, nonce, KIND_TRADE, market, hash, deadline);
        self.send(&[ix], &[wallet])
    }

    pub fn ix_cancel(&self, wallet: &Pubkey, participant_id: &[u8; 32], nonce: u64) -> Instruction {
        let participant = participant_pda(participant_id);
        Instruction {
            program_id: lm_id(),
            accounts: vec![
                AccountMeta::new_readonly(*wallet, true),
                AccountMeta::new_readonly(config_pda(), false),
                AccountMeta::new_readonly(participant, false),
                AccountMeta::new(intent_pda(&participant, nonce), false),
            ],
            data: self.idl.ix["cancel_intent"].clone(),
        }
    }

    pub fn cancel(&mut self, wallet: &Keypair, participant_id: &[u8; 32], nonce: u64) -> TxResult {
        let ix = self.ix_cancel(&wallet.pubkey(), participant_id, nonce);
        self.send(&[ix], &[wallet])
    }

    pub fn settle_request(&self, market: &Pubkey, batch_id: u64, items: &[(Pubkey, Vec<u8>)]) -> Vec<u8> {
        let mut req = vec![1u8];
        req.extend_from_slice(market.as_ref());
        req.extend_from_slice(&batch_id.to_le_bytes());
        (items.len() as u32).serialize(&mut req).unwrap();
        for (intent, contents) in items {
            req.extend_from_slice(intent.as_ref());
            contents.serialize(&mut req).unwrap();
        }
        req
    }

    pub fn settle_intent_metas(&self, participant_id: &[u8; 32], nonce: u64, wallet: &Pubkey, badge: &Badge) -> Vec<AccountMeta> {
        let participant = participant_pda(participant_id);
        vec![
            AccountMeta::new(intent_pda(&participant, nonce), false),
            AccountMeta::new_readonly(participant, false),
            AccountMeta::new_readonly(wallet_binding_pda(wallet), false),
            AccountMeta::new_readonly(badge.attestation, false),
            AccountMeta::new_readonly(badge.mint, false),
            AccountMeta::new_readonly(badge.token_account, false),
        ]
    }

    pub fn ix_settle(&self, request: Vec<u8>, intent_metas: Vec<AccountMeta>) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new_readonly(self.settlement_authority.pubkey(), true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new_readonly(self.credential, false),
            AccountMeta::new_readonly(self.schema, false),
            AccountMeta::new_readonly(self.schema_mint, false),
        ];
        accounts.extend(intent_metas);
        let mut data = self.idl.ix["settle_batch"].clone();
        data.extend(request);
        Instruction { program_id: lm_id(), accounts, data }
    }

    /// Settles a single trade intent with the given contents.
    pub fn settle_one(&mut self, participant_id: &[u8; 32], nonce: u64, wallet: &Pubkey, badge: &Badge, market: &Pubkey, contents: Vec<u8>) -> TxResult {
        let intent = intent_pda(&participant_pda(participant_id), nonce);
        let req = self.settle_request(market, 1, &[(intent, contents)]);
        let ix = self.ix_settle(req, self.settle_intent_metas(participant_id, nonce, wallet, badge));
        let sa = self.settlement_authority.insecure_clone();
        self.send(&[ix], &[&sa])
    }

    /// Clones an account to a new address, optionally changing owner and data.
    pub fn clone_account(&mut self, from: &Pubkey, owner: Option<Pubkey>, edit: impl FnOnce(&mut Vec<u8>)) -> Pubkey {
        let mut acct = self.svm.get_account(from).unwrap();
        if let Some(o) = owner {
            acct.owner = o;
        }
        edit(&mut acct.data);
        let to = Keypair::new().pubkey();
        self.svm.set_account(to, acct).unwrap();
        to
    }

    /// Overwrites an account's data in place.
    pub fn edit_account(&mut self, address: &Pubkey, edit: impl FnOnce(&mut Vec<u8>)) {
        let mut acct = self.svm.get_account(address).unwrap();
        edit(&mut acct.data);
        self.svm.set_account(*address, acct).unwrap();
    }
}

// ---------------------------------------------------------------------------
// SAS instruction encoders (layouts from solana-attestation 2.0.0)
// ---------------------------------------------------------------------------

fn borsh_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

pub fn sas_create_credential(payer: &Pubkey, authority: &Pubkey, name: &str, signers: &[Pubkey]) -> Instruction {
    let mut data = vec![0u8];
    borsh_str(&mut data, name);
    data.extend_from_slice(&(signers.len() as u32).to_le_bytes());
    for s in signers {
        data.extend_from_slice(s.as_ref());
    }
    Instruction {
        program_id: sas_id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(credential_pda(authority, name), false),
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data,
    }
}

pub fn sas_create_schema(payer: &Pubkey, authority: &Pubkey, credential: &Pubkey, schema: &Pubkey) -> Instruction {
    let mut data = vec![1u8];
    borsh_str(&mut data, SCHEMA_NAME);
    borsh_str(&mut data, SCHEMA_DESCRIPTION);
    data.extend_from_slice(&(SCHEMA_LAYOUT.len() as u32).to_le_bytes());
    data.extend_from_slice(&SCHEMA_LAYOUT);
    data.extend_from_slice(&(SCHEMA_FIELDS.len() as u32).to_le_bytes());
    for f in SCHEMA_FIELDS {
        borsh_str(&mut data, f);
    }
    Instruction {
        program_id: sas_id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new_readonly(*credential, false),
            AccountMeta::new(*schema, false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data,
    }
}

pub fn sas_tokenize_schema(payer: &Pubkey, authority: &Pubkey, credential: &Pubkey, schema: &Pubkey, max_size: u64) -> Instruction {
    let mut data = vec![9u8];
    data.extend_from_slice(&max_size.to_le_bytes());
    Instruction {
        program_id: sas_id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new_readonly(*credential, false),
            AccountMeta::new_readonly(*schema, false),
            AccountMeta::new(schema_mint_pda(schema), false),
            AccountMeta::new_readonly(sas_authority_pda(), false),
            AccountMeta::new_readonly(system_id(), false),
            AccountMeta::new_readonly(token_2022_id(), false),
        ],
        data,
    }
}

/// Exact Token-2022 mint size for a badge: base + account type + every TLV
/// extension SAS initializes, with the metadata sized from its real encoding.
pub fn badge_mint_space(attestation: &Pubkey, schema: &Pubkey, name: &str, symbol: &str, uri: &str) -> u16 {
    let tlv = |len: usize| 4 + len;
    let additional = [
        ("attestation", bs58::encode(attestation).into_string()),
        ("schema", bs58::encode(schema).into_string()),
    ];
    let metadata_len = 32 + 32 + (4 + name.len()) + (4 + symbol.len()) + (4 + uri.len())
        + 4 + additional.iter().map(|(k, v)| 4 + k.len() + 4 + v.len()).sum::<usize>();
    let size = 165 + 1
        + tlv(64)   // GroupMemberPointer
        + tlv(0)    // NonTransferable
        + tlv(64)   // MetadataPointer
        + tlv(32)   // PermanentDelegate
        + tlv(32)   // MintCloseAuthority
        + tlv(metadata_len) // TokenMetadata
        + tlv(72);  // TokenGroupMember
    size as u16
}

#[allow(clippy::too_many_arguments)]
pub fn sas_create_tokenized_attestation(
    payer: &Pubkey,
    signer: &Pubkey,
    credential: &Pubkey,
    schema: &Pubkey,
    attestation: &Pubkey,
    nonce: &Pubkey,
    recipient: &Pubkey,
    data_bytes: Vec<u8>,
    expiry: i64,
) -> Instruction {
    let mint = attestation_mint_pda(attestation);
    let mut data = vec![10u8];
    data.extend_from_slice(nonce.as_ref());
    data.extend_from_slice(&(data_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(&data_bytes);
    data.extend_from_slice(&expiry.to_le_bytes());
    borsh_str(&mut data, BADGE_NAME);
    borsh_str(&mut data, BADGE_URI);
    borsh_str(&mut data, BADGE_SYMBOL);
    data.extend_from_slice(&badge_mint_space(attestation, schema, BADGE_NAME, BADGE_SYMBOL, BADGE_URI).to_le_bytes());
    Instruction {
        program_id: sas_id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*signer, true),
            AccountMeta::new_readonly(*credential, false),
            AccountMeta::new_readonly(*schema, false),
            AccountMeta::new(*attestation, false),
            AccountMeta::new_readonly(system_id(), false),
            AccountMeta::new(schema_mint_pda(schema), false),
            AccountMeta::new(mint, false),
            AccountMeta::new_readonly(sas_authority_pda(), false),
            AccountMeta::new(ata(recipient, &mint), false),
            AccountMeta::new_readonly(*recipient, false),
            AccountMeta::new_readonly(token_2022_id(), false),
            AccountMeta::new_readonly(ata_program_id(), false),
        ],
        data,
    }
}

pub fn sas_close_tokenized_attestation(
    payer: &Pubkey,
    signer: &Pubkey,
    credential: &Pubkey,
    attestation: &Pubkey,
    mint: &Pubkey,
    token_account: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: sas_id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*signer, true),
            AccountMeta::new_readonly(*credential, false),
            AccountMeta::new(*attestation, false),
            AccountMeta::new_readonly(sas_event_authority_pda(), false),
            AccountMeta::new_readonly(system_id(), false),
            AccountMeta::new_readonly(sas_id(), false),
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(sas_authority_pda(), false),
            AccountMeta::new(*token_account, false),
            AccountMeta::new_readonly(token_2022_id(), false),
        ],
        data: vec![11u8],
    }
}

/// Token-2022 BurnChecked of the holder's own badge.
pub fn token_burn(token_account: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![15u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(0);
    Instruction {
        program_id: token_2022_id(),
        accounts: vec![
            AccountMeta::new(*token_account, false),
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(*owner, true),
        ],
        data,
    }
}
