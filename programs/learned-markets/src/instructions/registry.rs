use anchor_lang::prelude::*;

use super::*;
use crate::{
    constants::*,
    error::GateError,
    events::{BindingReplaced, ParticipantRegistered},
    gate::{self, GateMode},
    state::{
        Config, Participant, ParticipantStatus, WalletBinding, PARTICIPANT_VERSION,
        WALLET_BINDING_VERSION,
    },
};

#[derive(Accounts)]
#[instruction(participant_id: [u8; 32])]
pub struct RegisterParticipant<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The attested wallet; must sign its own registration.
    pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// `init` rejects an existing participant record.
    #[account(
        init,
        payer = payer,
        space = 8 + Participant::INIT_SPACE,
        seeds = [PARTICIPANT_SEED, config.app_scope.as_bytes(), participant_id.as_ref()],
        bump
    )]
    pub participant: Account<'info, Participant>,
    /// `init` rejects a wallet that is (or ever was) bound to any participant.
    #[account(
        init,
        payer = payer,
        space = 8 + WalletBinding::INIT_SPACE,
        seeds = [WALLET_BINDING_SEED, wallet.key().as_ref()],
        bump
    )]
    pub wallet_binding: Account<'info, WalletBinding>,
    pub badge: SasBadge<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_participant(
    ctx: Context<RegisterParticipant>,
    participant_id: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    gate::check_config(config)?;
    let wallet = ctx.accounts.wallet.key();

    let badge = gate::verify_badge(
        config,
        &ctx.accounts.badge.as_badge_accounts(),
        &wallet,
        now,
        GateMode::Admission,
    )?;
    require!(
        badge.data.participant_id == participant_id,
        GateError::ParticipantMismatch
    );
    gate::check_canonical_sas_addresses(config, &badge)?;

    let participant_key = ctx.accounts.participant.key();
    ctx.accounts.participant.set_inner(Participant {
        version: PARTICIPANT_VERSION,
        bump: ctx.bumps.participant,
        participant_id,
        current_wallet: wallet,
        current_attestation: badge.attestation,
        current_badge_mint: badge.badge_mint,
        binding_version: badge.data.binding_version,
        status: ParticipantStatus::Active,
        next_intent_nonce: 0,
        registered_at: now,
        updated_at: now,
    });
    ctx.accounts.wallet_binding.set_inner(WalletBinding {
        version: WALLET_BINDING_VERSION,
        bump: ctx.bumps.wallet_binding,
        wallet,
        participant: participant_key,
        participant_id,
        active: true,
        bound_at: now,
        retired_at: 0,
    });

    emit!(ParticipantRegistered {
        participant: participant_key,
        participant_id,
        wallet,
        attestation: badge.attestation,
        binding_version: badge.data.binding_version,
    });
    Ok(())
}

/// Replaces (or renews) a suspended participant's binding with a new
/// attestation at `binding_version + 1`. Requires the admin and the new
/// wallet. Identity, history and the intent nonce sequence are preserved;
/// intents signed under the previous binding version become stale.
#[derive(Accounts)]
pub struct ReplaceBinding<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    pub new_wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ GateError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [PARTICIPANT_SEED, config.app_scope.as_bytes(), participant.participant_id.as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, Participant>,
    /// Binding of the current wallet. Required when the wallet changes; must be
    /// omitted for a same-wallet renewal (it is then `new_wallet_binding`).
    #[account(
        mut,
        seeds = [WALLET_BINDING_SEED, participant.current_wallet.as_ref()],
        bump = old_wallet_binding.bump
    )]
    pub old_wallet_binding: Option<Account<'info, WalletBinding>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + WalletBinding::INIT_SPACE,
        seeds = [WALLET_BINDING_SEED, new_wallet.key().as_ref()],
        bump
    )]
    pub new_wallet_binding: Account<'info, WalletBinding>,
    pub badge: SasBadge<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_replace_binding(ctx: Context<ReplaceBinding>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    gate::check_config(config)?;
    let participant_key = ctx.accounts.participant.key();
    let new_wallet = ctx.accounts.new_wallet.key();

    {
        let participant = &ctx.accounts.participant;
        match participant.status {
            ParticipantStatus::Suspended => {}
            ParticipantStatus::Revoked => return err!(GateError::ParticipantRevoked),
            ParticipantStatus::Active => return err!(GateError::ParticipantNotSuspended),
        }
    }

    let badge = gate::verify_badge(
        config,
        &ctx.accounts.badge.as_badge_accounts(),
        &new_wallet,
        now,
        GateMode::Standing,
    )?;
    let participant = &ctx.accounts.participant;
    require!(
        badge.data.participant_id == participant.participant_id,
        GateError::ParticipantMismatch
    );
    let next_version = participant
        .binding_version
        .checked_add(1)
        .ok_or(GateError::Overflow)?;
    require!(
        badge.data.binding_version == next_version,
        GateError::BindingVersionMismatch
    );
    gate::check_canonical_sas_addresses(config, &badge)?;

    let previous_wallet = participant.current_wallet;
    let wallet_changes = previous_wallet != new_wallet;

    // Retire the previous binding atomically so two active bindings never coexist.
    match (&mut ctx.accounts.old_wallet_binding, wallet_changes) {
        (Some(old), true) => {
            require_keys_eq!(old.participant, participant_key, GateError::WalletBindingMismatch);
            old.active = false;
            old.retired_at = now;
        }
        (None, false) => {}
        _ => return err!(GateError::WalletBindingMismatch),
    }

    let binding = &mut ctx.accounts.new_wallet_binding;
    if binding.participant == Pubkey::default() {
        // Freshly created by init_if_needed.
        binding.set_inner(WalletBinding {
            version: WALLET_BINDING_VERSION,
            bump: ctx.bumps.new_wallet_binding,
            wallet: new_wallet,
            participant: participant_key,
            participant_id: badge.data.participant_id,
            active: true,
            bound_at: now,
            retired_at: 0,
        });
    } else {
        require_keys_eq!(
            binding.participant,
            participant_key,
            GateError::WalletBoundToOtherParticipant
        );
        binding.active = true;
        binding.bound_at = now;
        binding.retired_at = 0;
    }

    let participant = &mut ctx.accounts.participant;
    participant.current_wallet = new_wallet;
    participant.current_attestation = badge.attestation;
    participant.current_badge_mint = badge.badge_mint;
    participant.binding_version = next_version;
    participant.status = ParticipantStatus::Active;
    participant.updated_at = now;

    emit!(BindingReplaced {
        participant: participant_key,
        previous_wallet,
        wallet: new_wallet,
        attestation: badge.attestation,
        binding_version: next_version,
    });
    Ok(())
}
