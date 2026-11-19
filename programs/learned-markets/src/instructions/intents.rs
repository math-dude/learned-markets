use anchor_lang::prelude::*;

use super::*;
use crate::{
    constants::*,
    error::GateError,
    events::{IntentCancelled, IntentSubmitted},
    gate::{self, GateMode},
    state::{Config, Intent, IntentKind, IntentState, Participant, WalletBinding, INTENT_VERSION},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct SubmitIntentArgs {
    /// Must equal the participant's `next_intent_nonce`.
    pub nonce: u64,
    pub kind: IntentKind,
    pub target: Pubkey,
    /// `payload::payload_hash` of the canonical payload.
    pub payload_hash: [u8; 32],
    /// Unix seconds; at most five minutes ahead and no later than the badge expiry.
    pub deadline: i64,
}

#[derive(Accounts)]
#[instruction(args: SubmitIntentArgs)]
pub struct SubmitIntent<'info> {
    /// Current wallet of the participant; pays for the intent record.
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [PARTICIPANT_SEED, config.app_scope.as_bytes(), participant.participant_id.as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, Participant>,
    #[account(seeds = [WALLET_BINDING_SEED, wallet.key().as_ref()], bump = wallet_binding.bump)]
    pub wallet_binding: Account<'info, WalletBinding>,
    pub badge: SasBadge<'info>,
    #[account(
        init,
        payer = wallet,
        space = 8 + Intent::INIT_SPACE,
        seeds = [INTENT_SEED, participant.key().as_ref(), args.nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub intent: Account<'info, Intent>,
    pub system_program: Program<'info, System>,
}

pub fn handle_submit_intent(ctx: Context<SubmitIntent>, args: SubmitIntentArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let wallet = ctx.accounts.wallet.key();
    require_keys_eq!(
        wallet,
        ctx.accounts.participant.current_wallet,
        GateError::WalletNotCurrent
    );

    let badge = gate::require_eligible(
        &ctx.accounts.config,
        &ctx.accounts.participant,
        &ctx.accounts.wallet_binding,
        &ctx.accounts.badge.as_badge_accounts(),
        now,
        GateMode::Admission,
    )?;

    let participant = &mut ctx.accounts.participant;
    require!(
        args.nonce == participant.next_intent_nonce,
        GateError::WrongIntentNonce
    );
    require!(args.deadline > now, GateError::InvalidIntentDeadline);
    let max_deadline = now
        .checked_add(MAX_INTENT_LIFETIME_SECS)
        .ok_or(GateError::Overflow)?
        .min(badge.expiry);
    require!(
        args.deadline <= max_deadline,
        GateError::InvalidIntentDeadline
    );
    require!(args.target != Pubkey::default(), GateError::IntentTargetMismatch);

    participant.next_intent_nonce = participant
        .next_intent_nonce
        .checked_add(1)
        .ok_or(GateError::Overflow)?;
    let participant_key = participant.key();
    let binding_version = participant.binding_version;

    let intent_key = ctx.accounts.intent.key();
    ctx.accounts.intent.set_inner(Intent {
        version: INTENT_VERSION,
        bump: ctx.bumps.intent,
        participant: participant_key,
        wallet,
        binding_version,
        nonce: args.nonce,
        kind: args.kind,
        target: args.target,
        payload_hash: args.payload_hash,
        created_at: now,
        deadline: args.deadline,
        state: IntentState::Open,
    });

    emit!(IntentSubmitted {
        intent: intent_key,
        participant: participant_key,
        nonce: args.nonce,
        kind: args.kind,
        target: args.target,
        payload_hash: args.payload_hash,
        deadline: args.deadline,
    });
    Ok(())
}

/// Ownership-based cancellation. Requires only the participant's current
/// wallet; deliberately independent of admission pauses, badge expiry and
/// participant status.
#[derive(Accounts)]
pub struct CancelIntent<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [PARTICIPANT_SEED, config.app_scope.as_bytes(), participant.participant_id.as_ref()],
        bump = participant.bump,
        constraint = participant.current_wallet == wallet.key() @ GateError::WalletNotCurrent
    )]
    pub participant: Account<'info, Participant>,
    #[account(
        mut,
        seeds = [INTENT_SEED, participant.key().as_ref(), intent.nonce.to_le_bytes().as_ref()],
        bump = intent.bump,
        constraint = intent.participant == participant.key() @ GateError::IntentOwnerMismatch
    )]
    pub intent: Account<'info, Intent>,
}

pub fn handle_cancel_intent(ctx: Context<CancelIntent>) -> Result<()> {
    let intent = &mut ctx.accounts.intent;
    require!(intent.state == IntentState::Open, GateError::IntentNotOpen);
    intent.state = IntentState::Cancelled;
    emit!(IntentCancelled {
        intent: intent.key(),
        participant: intent.participant,
        nonce: intent.nonce,
    });
    Ok(())
}
