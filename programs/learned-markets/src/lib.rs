//! Learned Markets participant registry, gated intents and settlement scaffold.
//!
//! * Registry: `Config`, `Participant`, `WalletBinding` PDAs bind one SAS-attested
//!   participant to exactly one active wallet.
//! * Gate: `gate::require_eligible` is executed inside every protected instruction.
//! * Intents: `Trade` and `Nomination` intents with persistent per-participant nonces.
//! * Settlement: `settle_batch` validates and then returns `SettlementNotImplemented`.

pub mod accounting;
pub mod assets;
pub mod constants;
pub mod error;
pub mod events;
pub mod gate;
pub mod instructions;
pub mod market;
pub mod tokens;
pub use market::*;
pub mod payload;
pub mod references;
pub mod sas;
pub mod settlement;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use settlement::{SettlementIntentRef, SettlementRequestV1, SettlementResultV1};
pub use state::*;

declare_id!("nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz");

#[program]
pub mod learned_markets {
    use super::*;

    pub fn initialize_board(ctx: Context<InitializeBoard>, args: BoardArgs) -> Result<()> {
        instructions::board::init(ctx, args)
    }
    pub fn update_board(ctx: Context<UpdateBoard>, args: UpdateBoardArgs) -> Result<()> {
        instructions::board::update(ctx, args)
    }
    pub fn create_market(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        instructions::launch::create(ctx, args)
    }
    pub fn set_stage(ctx: Context<SetStage>, stage: Stage) -> Result<()> {
        instructions::board::stage(ctx, stage)
    }
    pub fn deposit_base(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::funds::deposit(ctx, amount, true)
    }
    pub fn deposit_quote(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::funds::deposit(ctx, amount, false)
    }
    pub fn withdraw_base(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::funds::withdraw(ctx, amount, true)
    }
    pub fn withdraw_quote(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::funds::withdraw(ctx, amount, false)
    }

    /// Deployment authority only. Pins the SAS trust anchors.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        instructions::admin::handle_initialize_config(ctx, args)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::admin::handle_update_config(ctx, args)
    }

    pub fn register_participant(
        ctx: Context<RegisterParticipant>,
        participant_id: [u8; 32],
    ) -> Result<()> {
        instructions::registry::handle_register_participant(ctx, participant_id)
    }

    pub fn suspend_participant(ctx: Context<SetParticipantStatus>) -> Result<()> {
        instructions::admin::handle_suspend_participant(ctx)
    }

    pub fn revoke_participant(ctx: Context<SetParticipantStatus>) -> Result<()> {
        instructions::admin::handle_revoke_participant(ctx)
    }

    pub fn replace_binding(ctx: Context<ReplaceBinding>) -> Result<()> {
        instructions::registry::handle_replace_binding(ctx)
    }

    pub fn submit_intent(ctx: Context<SubmitIntent>, args: SubmitIntentArgs) -> Result<()> {
        instructions::intents::handle_submit_intent(ctx, args)
    }

    pub fn cancel_intent(ctx: Context<CancelIntent>) -> Result<()> {
        instructions::intents::handle_cancel_intent(ctx)
    }

    /// Reserved settlement entrypoint: validates, then returns `SettlementNotImplemented`.
    pub fn settle_batch<'info>(
        ctx: Context<'info, SettleBatch<'info>>,
        request: SettlementRequestV1,
    ) -> Result<()> {
        instructions::settle::handle_settle_batch(ctx, request)
    }
}
