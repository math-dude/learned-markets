//! Settlement module boundary (scaffold).
//!
//! What exists today:
//! * Versioned request/result types referencing market, batch and intents.
//! * [`validate_batch`]: the reusable checks every future settlement must pass:
//!   current participant eligibility (full guard), intent ownership, target,
//!   payload hash, expiry, binding version and replay state.
//! * [`execute`]: the single place where intents will be consumed, in the same
//!   instruction as (and after) the engine's economic state changes, so the
//!   two are atomic. The only engine today is [`NotImplementedEngine`], which
//!   returns `SettlementNotImplemented` *before* any intent is touched.
//!
//! Deliberately absent: token custody, deposits, fund reservations, fill
//! mathematics, fees, asset transfers, and any generic CPI. Escrow versus
//! another settlement model is an open decision.

use std::collections::BTreeSet;

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::GateError,
    gate::{self, BadgeAccounts, GateMode},
    instructions::SasBadgeShared,
    payload,
    state::{Config, Intent, IntentKind, IntentState, Participant, WalletBinding},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct SettlementIntentRef {
    pub intent: Pubkey,
    /// Kind-specific canonical contents; must hash to `intent.payload_hash`.
    pub contents: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct SettlementRequestV1 {
    pub version: u8,
    pub market: Pubkey,
    pub batch_id: u64,
    pub intents: Vec<SettlementIntentRef>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementStatus {
    Settled,
}

/// Reserved for the implementation: returned via return data on success.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct SettlementResultV1 {
    pub version: u8,
    pub market: Pubkey,
    pub batch_id: u64,
    pub status: SettlementStatus,
    pub consumed_intents: Vec<Pubkey>,
}

/// An intent that passed every settlement check. Constructible only by
/// [`validate_batch`].
pub struct ValidatedIntent<'info> {
    pub intent: Account<'info, Intent>,
    pub participant: Pubkey,
    pub contents: Vec<u8>,
    _private: (),
}

pub struct ValidatedBatch<'info> {
    pub market: Pubkey,
    pub batch_id: u64,
    pub intents: Vec<ValidatedIntent<'info>>,
    _private: (),
}

/// Economic settlement engine. Implementations apply fills/transfers and
/// must not touch intent state; [`execute`] consumes intents afterwards.
pub trait SettlementEngine {
    fn apply(&self, batch: &ValidatedBatch) -> Result<()>;
}

pub struct NotImplementedEngine;

impl SettlementEngine for NotImplementedEngine {
    fn apply(&self, _batch: &ValidatedBatch) -> Result<()> {
        err!(GateError::SettlementNotImplemented)
    }
}

/// Validates a settlement request against `remaining_accounts`, laid out as
/// `SETTLEMENT_ACCOUNTS_PER_INTENT` accounts per intent, in request order:
/// intent, participant, wallet binding, attestation, badge mint, badge token account.
pub fn validate_batch<'info>(
    config: &Account<'info, Config>,
    shared: &SasBadgeShared<'info>,
    remaining: &'info [AccountInfo<'info>],
    request: &SettlementRequestV1,
    now: i64,
) -> Result<ValidatedBatch<'info>> {
    gate::check_config(config)?;
    require!(
        request.version == SETTLEMENT_REQUEST_VERSION,
        GateError::MalformedSettlementRequest
    );
    require!(
        !request.intents.is_empty() && request.intents.len() <= MAX_SETTLEMENT_INTENTS,
        GateError::MalformedSettlementRequest
    );
    require!(
        remaining.len() == request.intents.len() * SETTLEMENT_ACCOUNTS_PER_INTENT,
        GateError::SettlementAccountsMismatch
    );

    let mut seen = BTreeSet::new();
    let mut intents = Vec::with_capacity(request.intents.len());
    for (i, item) in request.intents.iter().enumerate() {
        require!(seen.insert(item.intent), GateError::DuplicateSettlementIntent);
        let accts = &remaining[i * SETTLEMENT_ACCOUNTS_PER_INTENT..(i + 1) * SETTLEMENT_ACCOUNTS_PER_INTENT];
        require_keys_eq!(accts[0].key(), item.intent, GateError::SettlementAccountsMismatch);

        // Account<T>::try_from enforces program ownership and discriminators.
        let intent: Account<'info, Intent> = Account::try_from(&accts[0])
            .map_err(|_| error!(GateError::SettlementAccountsMismatch))?;
        let participant: Account<'info, Participant> = Account::try_from(&accts[1])
            .map_err(|_| error!(GateError::SettlementAccountsMismatch))?;
        let wallet_binding: Account<'info, WalletBinding> = Account::try_from(&accts[2])
            .map_err(|_| error!(GateError::SettlementAccountsMismatch))?;

        let expected_intent = Pubkey::create_program_address(
            &[
                INTENT_SEED,
                participant.key().as_ref(),
                &intent.nonce.to_le_bytes(),
                &[intent.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(GateError::NonCanonicalRegistryAccount))?;
        require_keys_eq!(intent.key(), expected_intent, GateError::NonCanonicalRegistryAccount);
        require_keys_eq!(intent.participant, participant.key(), GateError::IntentOwnerMismatch);
        require!(intent.state == IntentState::Open, GateError::IntentNotOpen);
        require!(now <= intent.deadline, GateError::IntentExpired);
        require!(
            intent.binding_version == participant.binding_version,
            GateError::StaleIntentBinding
        );
        require_keys_eq!(intent.target, request.market, GateError::IntentTargetMismatch);
        require!(intent.kind == IntentKind::Trade, GateError::WrongIntentKind);
        payload::validate_contents(intent.kind, &item.contents)?;
        let hash = payload::payload_hash(
            &config.app_scope,
            &config.network,
            intent.kind,
            &intent.target,
            &item.contents,
        );
        require!(hash == intent.payload_hash, GateError::PayloadHashMismatch);

        // Full current eligibility, rechecked at the settlement boundary.
        let badge_accounts = BadgeAccounts {
            credential: shared.credential.as_ref(),
            schema: shared.schema.as_ref(),
            schema_mint: shared.schema_mint.as_ref(),
            attestation: &accts[3],
            badge_mint: &accts[4],
            badge_token_account: &accts[5],
        };
        gate::require_eligible(
            config,
            &participant,
            &wallet_binding,
            &badge_accounts,
            now,
            GateMode::Standing,
        )?;

        intents.push(ValidatedIntent {
            participant: participant.key(),
            intent,
            contents: item.contents.clone(),
            _private: (),
        });
    }

    Ok(ValidatedBatch {
        market: request.market,
        batch_id: request.batch_id,
        intents,
        _private: (),
    })
}

/// Applies the engine, then consumes every intent in the same instruction.
/// If the engine fails, nothing is consumed (and the transaction aborts).
pub fn execute<E: SettlementEngine>(
    engine: &E,
    mut batch: ValidatedBatch,
) -> Result<SettlementResultV1> {
    engine.apply(&batch)?;
    let mut consumed = Vec::with_capacity(batch.intents.len());
    for v in batch.intents.iter_mut() {
        v.intent.state = IntentState::Consumed;
        v.intent.exit(&crate::ID)?;
        consumed.push(v.intent.key());
    }
    Ok(SettlementResultV1 {
        version: SETTLEMENT_REQUEST_VERSION,
        market: batch.market,
        batch_id: batch.batch_id,
        status: SettlementStatus::Settled,
        consumed_intents: consumed,
    })
}
