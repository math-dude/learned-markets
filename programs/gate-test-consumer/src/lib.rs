//! Test consumer: a third-party program that reaches the gate through CPI.
//!
//! Demonstrates that the gate's protections hold for programmatic callers:
//! the gated instructions run the full guard on whatever accounts the caller
//! forwards, so omitting or substituting gate accounts fails.

use anchor_lang::prelude::*;
use learned_markets::{
    cpi::accounts::{SasBadge, SasBadgeShared, SettleBatch, SubmitIntent},
    program::LearnedMarkets,
    SettlementRequestV1, SubmitIntentArgs,
};

declare_id!("ZwKZ5pjQuiEr6AbHCj4BibaCLfyagQj8Ye4nfHRRx4q");

#[program]
pub mod gate_test_consumer {
    use super::*;

    pub fn proxy_submit_intent(ctx: Context<ProxySubmitIntent>, args: SubmitIntentArgs) -> Result<()> {
        let a = &ctx.accounts;
        let accounts = SubmitIntent {
            wallet: a.wallet.to_account_info(),
            config: a.config.to_account_info(),
            participant: a.participant.to_account_info(),
            wallet_binding: a.wallet_binding.to_account_info(),
            badge: SasBadge {
                credential: a.credential.to_account_info(),
                schema: a.schema.to_account_info(),
                schema_mint: a.schema_mint.to_account_info(),
                attestation: a.attestation.to_account_info(),
                badge_mint: a.badge_mint.to_account_info(),
                badge_token_account: a.badge_token_account.to_account_info(),
            },
            intent: a.intent.to_account_info(),
            system_program: a.system_program.to_account_info(),
        };
        learned_markets::cpi::submit_intent(CpiContext::new(a.gate_program.key(), accounts), args)
    }

    pub fn proxy_settle_batch<'info>(
        ctx: Context<'info, ProxySettleBatch<'info>>,
        request: SettlementRequestV1,
    ) -> Result<()> {
        let a = &ctx.accounts;
        let accounts = SettleBatch {
            settlement_authority: a.settlement_authority.to_account_info(),
            config: a.config.to_account_info(),
            sas: SasBadgeShared {
                credential: a.credential.to_account_info(),
                schema: a.schema.to_account_info(),
                schema_mint: a.schema_mint.to_account_info(),
            },
        };
        let cpi = CpiContext::new(a.gate_program.key(), accounts)
            .with_remaining_accounts(ctx.remaining_accounts.to_vec());
        learned_markets::cpi::settle_batch(cpi, request)
    }
}

#[derive(Accounts)]
pub struct ProxySubmitIntent<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub config: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    #[account(mut)]
    pub participant: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub wallet_binding: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub credential: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub schema: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub schema_mint: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub badge_mint: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub badge_token_account: UncheckedAccount<'info>,
    /// CHECK: forwarded; created by the gate.
    #[account(mut)]
    pub intent: UncheckedAccount<'info>,
    pub gate_program: Program<'info, LearnedMarkets>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProxySettleBatch<'info> {
    pub settlement_authority: Signer<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub config: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub credential: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub schema: UncheckedAccount<'info>,
    /// CHECK: forwarded; validated by the gate.
    pub schema_mint: UncheckedAccount<'info>,
    pub gate_program: Program<'info, LearnedMarkets>,
}
