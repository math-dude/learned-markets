//! The shared eligibility guard.
//!
//! Every protected instruction (registration, binding replacement, intent
//! submission, settlement validation) calls into this module with the raw
//! accounts it was given and performs the full check itself. Nothing here
//! trusts an earlier "verification succeeded" transaction.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::GateError,
    sas::{self, ParticipantData},
    state::{Config, Participant, ParticipantStatus, WalletBinding},
};

/// Which pause switches apply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateMode {
    /// New registrations and new intents: the config admission flag and the SAS
    /// schema pause both deny.
    Admission,
    /// Admin binding replacement and settlement of already-admitted intents:
    /// pauses do not apply, every other check does.
    Standing,
}

/// SAS and badge accounts that accompany every protected instruction.
pub struct BadgeAccounts<'a, 'info> {
    pub credential: &'a AccountInfo<'info>,
    pub schema: &'a AccountInfo<'info>,
    pub schema_mint: &'a AccountInfo<'info>,
    pub attestation: &'a AccountInfo<'info>,
    pub badge_mint: &'a AccountInfo<'info>,
    pub badge_token_account: &'a AccountInfo<'info>,
}

/// Result of a successful badge verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedBadge {
    pub data: ParticipantData,
    pub attestation: Pubkey,
    pub badge_mint: Pubkey,
    pub expiry: i64,
}

/// Verifies the config account is the canonical, program-owned config PDA.
pub fn check_config(config: &Account<Config>) -> Result<()> {
    let expected = Pubkey::create_program_address(&[CONFIG_SEED, &[config.bump]], &crate::ID)
        .map_err(|_| error!(GateError::NonCanonicalRegistryAccount))?;
    require_keys_eq!(
        config.key(),
        expected,
        GateError::NonCanonicalRegistryAccount
    );
    Ok(())
}

pub fn participant_address(config: &Config, participant_id: &[u8; 32], bump: u8) -> Result<Pubkey> {
    Pubkey::create_program_address(
        &[
            PARTICIPANT_SEED,
            config.app_scope.as_bytes(),
            participant_id,
            &[bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(GateError::NonCanonicalRegistryAccount))
}

pub fn wallet_binding_address(wallet: &Pubkey, bump: u8) -> Result<Pubkey> {
    Pubkey::create_program_address(&[WALLET_BINDING_SEED, wallet.as_ref(), &[bump]], &crate::ID)
        .map_err(|_| error!(GateError::NonCanonicalRegistryAccount))
}

/// Verifies a SAS tokenized attestation for `expected_wallet` against the
/// trusted configuration. Does not consult the registry; used directly by
/// registration and replacement, and by [`require_eligible`].
pub fn verify_badge(
    config: &Config,
    accounts: &BadgeAccounts,
    expected_wallet: &Pubkey,
    now: i64,
    mode: GateMode,
) -> Result<VerifiedBadge> {
    let sas_program = config.sas_program;

    // Credential: exact trusted credential and authority.
    require_keys_eq!(
        accounts.credential.key(),
        config.credential,
        GateError::UntrustedCredential
    );
    let credential = sas::decode_credential(accounts.credential, &sas_program)?;
    require_keys_eq!(
        credential.authority,
        config.credential_authority,
        GateError::UntrustedCredentialAuthority
    );

    // Schema: exact trusted schema, version, layout, owned by the credential.
    require_keys_eq!(
        accounts.schema.key(),
        config.schema,
        GateError::UntrustedSchema
    );
    let schema = sas::decode_schema(accounts.schema, &sas_program)?;
    require_keys_eq!(
        schema.credential,
        config.credential,
        GateError::UntrustedSchema
    );
    require!(
        schema.version == config.schema_version,
        GateError::SchemaVersionMismatch
    );
    require!(
        schema.layout.as_slice() == SCHEMA_LAYOUT,
        GateError::SchemaLayoutMismatch
    );
    if mode == GateMode::Admission {
        require!(!schema.is_paused, GateError::AdmissionSuspended);
        require!(!config.admission_paused, GateError::AdmissionSuspended);
    }
    require_keys_eq!(
        accounts.schema_mint.key(),
        config.schema_mint,
        GateError::BadgeNotInSchemaGroup
    );

    // Attestation: SAS-owned, bound to the trusted credential/schema, signed by a
    // currently authorized signer.
    let attestation = sas::decode_attestation(accounts.attestation, &sas_program)?;
    require_keys_eq!(
        attestation.credential,
        config.credential,
        GateError::UntrustedCredential
    );
    require_keys_eq!(
        attestation.schema,
        config.schema,
        GateError::UntrustedSchema
    );
    require!(
        credential
            .authorized_signers
            .iter()
            .any(|s| *s == attestation.signer),
        GateError::UnauthorizedAttestationSigner
    );

    // Payload semantics.
    let data = ParticipantData::decode(&attestation.data)?;
    require!(
        data.app_scope == config.app_scope,
        GateError::WrongAppScope
    );
    require!(
        data.verification_method == config.allowed_verification_method,
        GateError::UnsupportedVerificationMethod
    );
    require!(data.binding_version >= 1, GateError::BindingVersionMismatch);
    require_keys_eq!(data.wallet, *expected_wallet, GateError::WalletMismatch);
    require_keys_eq!(
        attestation.nonce,
        sas::attestation_nonce(&data.participant_id, data.binding_version),
        GateError::NonCanonicalAttestation
    );
    sas::check_validity_window(data.issued_at, attestation.expiry, now)?;

    // Badge mint.
    require_keys_eq!(
        *accounts.badge_mint.owner,
        TOKEN_2022_PROGRAM_ID,
        GateError::BadgeWrongTokenProgram
    );
    let mint = sas::parse_badge_mint(&accounts.badge_mint.try_borrow_data()?)?;
    require!(mint.non_transferable, GateError::BadgeTransferable);
    require!(
        mint.mint_authority == Some(config.sas_authority),
        GateError::BadgeWrongMintAuthority
    );
    require!(
        mint.decimals == 0 && mint.supply == 1,
        GateError::BadgeWrongSupply
    );
    match mint.group_member {
        Some((member_mint, group)) => {
            require_keys_eq!(
                member_mint,
                accounts.badge_mint.key(),
                GateError::BadgeNotInSchemaGroup
            );
            require_keys_eq!(group, config.schema_mint, GateError::BadgeNotInSchemaGroup);
        }
        None => return err!(GateError::BadgeNotInSchemaGroup),
    }

    // Badge token account: the one SAS recorded, held by the bound wallet.
    require_keys_eq!(
        accounts.badge_token_account.key(),
        attestation.token_account,
        GateError::BadgeTokenAccountMismatch
    );
    require_keys_eq!(
        *accounts.badge_token_account.owner,
        TOKEN_2022_PROGRAM_ID,
        GateError::BadgeWrongTokenProgram
    );
    let token = sas::parse_token_account(&accounts.badge_token_account.try_borrow_data()?)?;
    require_keys_eq!(
        token.mint,
        accounts.badge_mint.key(),
        GateError::BadgeTokenAccountMismatch
    );
    require_keys_eq!(
        token.owner,
        *expected_wallet,
        GateError::BadgeTokenAccountMismatch
    );
    require!(token.state == 1, GateError::MalformedBadgeTokenAccount);
    require!(token.amount == 1, GateError::BadgeNotHeld);

    Ok(VerifiedBadge {
        data,
        attestation: accounts.attestation.key(),
        badge_mint: accounts.badge_mint.key(),
        expiry: attestation.expiry,
    })
}

/// Derives (with `find_program_address`) the canonical SAS attestation and badge
/// mint addresses for a verified badge and checks the supplied accounts match.
/// Used whenever a new attestation is bound into the registry; later checks
/// compare against the stored addresses.
pub fn check_canonical_sas_addresses(config: &Config, badge: &VerifiedBadge) -> Result<()> {
    let nonce = sas::attestation_nonce(&badge.data.participant_id, badge.data.binding_version);
    let (attestation, _) = Pubkey::find_program_address(
        &[
            SAS_ATTESTATION_SEED,
            config.credential.as_ref(),
            config.schema.as_ref(),
            nonce.as_ref(),
        ],
        &config.sas_program,
    );
    require_keys_eq!(
        attestation,
        badge.attestation,
        GateError::NonCanonicalAttestation
    );
    let (mint, _) = Pubkey::find_program_address(
        &[SAS_ATTESTATION_MINT_SEED, attestation.as_ref()],
        &config.sas_program,
    );
    require_keys_eq!(mint, badge.badge_mint, GateError::NonCanonicalBadgeMint);
    Ok(())
}

/// Full current eligibility for a registered participant: registry state,
/// current binding, and a valid badge. Called inside every protected action.
pub fn require_eligible(
    config: &Account<Config>,
    participant: &Account<Participant>,
    wallet_binding: &Account<WalletBinding>,
    badge_accounts: &BadgeAccounts,
    now: i64,
    mode: GateMode,
) -> Result<VerifiedBadge> {
    check_config(config)?;
    require_keys_eq!(
        participant.key(),
        participant_address(config, &participant.participant_id, participant.bump)?,
        GateError::NonCanonicalRegistryAccount
    );
    match participant.status {
        ParticipantStatus::Active => {}
        ParticipantStatus::Revoked => return err!(GateError::ParticipantRevoked),
        ParticipantStatus::Suspended => return err!(GateError::ParticipantNotActive),
    }

    require_keys_eq!(
        wallet_binding.key(),
        wallet_binding_address(&wallet_binding.wallet, wallet_binding.bump)?,
        GateError::NonCanonicalRegistryAccount
    );
    require_keys_eq!(
        wallet_binding.wallet,
        participant.current_wallet,
        GateError::WalletNotCurrent
    );
    require_keys_eq!(
        wallet_binding.participant,
        participant.key(),
        GateError::WalletBindingMismatch
    );
    require!(wallet_binding.active, GateError::WalletBindingInactive);

    require_keys_eq!(
        badge_accounts.attestation.key(),
        participant.current_attestation,
        GateError::AttestationNotCurrent
    );
    require_keys_eq!(
        badge_accounts.badge_mint.key(),
        participant.current_badge_mint,
        GateError::NonCanonicalBadgeMint
    );

    let badge = verify_badge(config, badge_accounts, &participant.current_wallet, now, mode)?;
    require!(
        badge.data.participant_id == participant.participant_id,
        GateError::ParticipantMismatch
    );
    require!(
        badge.data.binding_version == participant.binding_version,
        GateError::BindingVersionMismatch
    );
    Ok(badge)
}
