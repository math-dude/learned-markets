use anchor_lang::prelude::*;


use crate::{
    constants::*,
    error::GateError,
    settlement::{self, NotImplementedEngine, SettlementRequestV1},
    state::Config,
};

/// SAS accounts shared by every intent in a settlement batch.
#[derive(Accounts)]
pub struct SasBadgeShared<'info> {
    /// CHECK: validated by the shared guard.
    pub credential: UncheckedAccount<'info>,
    /// CHECK: validated by the shared guard.
    pub schema: UncheckedAccount<'info>,
    /// CHECK: validated by the shared guard.
    pub schema_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleBatch<'info> {
    pub settlement_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = settlement_authority @ GateError::NotSettlementAuthority
    )]
    pub config: Account<'info, Config>,
    pub sas: SasBadgeShared<'info>,
    // remaining_accounts: SETTLEMENT_ACCOUNTS_PER_INTENT per intent; see settlement::validate_batch.
}

pub fn handle_settle_batch<'info>(
    ctx: Context<'info, SettleBatch<'info>>,
    request: SettlementRequestV1,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let batch = settlement::validate_batch(
        &ctx.accounts.config,
        &ctx.accounts.sas,
        ctx.remaining_accounts,
        &request,
        now,
    )?;
    // Returns SettlementNotImplemented before any intent is consumed.
    let result = settlement::execute(&NotImplementedEngine, batch)?;
    anchor_lang::solana_program::program::set_return_data(&anchor_lang::prelude::borsh::to_vec(&result)?);
    Ok(())
}
