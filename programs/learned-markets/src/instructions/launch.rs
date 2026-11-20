use super::*;
use crate::{
    accounting::checked_credit,
    constants::*,
    error::GateError,
    events::MarketCreated,
    gate::{require_eligible, GateMode},
    instructions::SasBadge,
    market::*,
    state::*,
    tokens,
};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateMarketArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub total_supply: u64,
    pub open_price: u64,
    pub batch_len_slots: u32,
    pub bounds: TermsBounds,
    pub limits: MakerLimits,
    pub deployer_fee_bps: u16,
    pub platform_fee_share_bps: u16,
    pub quoter: Pubkey,
}
#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut,seeds=[b"board"],bump=board.bump)]
    pub board: Account<'info, BoardConfig>,
    #[account(seeds=[CONFIG_SEED],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds=[PARTICIPANT_SEED,config.app_scope.as_bytes(),participant.participant_id.as_ref()],bump=participant.bump,
        constraint=wallet.key()==participant.current_wallet @ GateError::WalletNotCurrent)]
    pub participant: Account<'info, Participant>,
    #[account(seeds=[WALLET_BINDING_SEED,wallet.key().as_ref()],bump=wallet_binding.bump)]
    pub wallet_binding: Account<'info, WalletBinding>,
    pub badge: SasBadge<'info>,
    /// CHECK: PDA created and initialized via Token-2022 CPI.
    #[account(mut,seeds=[b"mint",participant.key().as_ref(),board.markets_created.to_le_bytes().as_ref()],bump)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: owner, mint layout and launch asset validated.
    #[account(address=board.launch_quote_mint @ GateError::QuoteMintNotAllowed)]
    pub quote_mint: UncheckedAccount<'info>,
    #[account(init,payer=wallet,space=8+Market::INIT_SPACE,seeds=[b"market",base_mint.key().as_ref()],bump)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: PDA created and initialized via Token-2022.
    #[account(mut,seeds=[b"vault",market.key().as_ref(),base_mint.key().as_ref()],bump)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: PDA created and initialized via token CPI.
    #[account(mut,seeds=[b"vault",market.key().as_ref(),quote_mint.key().as_ref()],bump)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: validated by inspect_token and transfer_checked.
    #[account(mut)]
    pub wallet_quote: UncheckedAccount<'info>,
    /// CHECK: pinned Token-2022 program.
    #[account(address=spl_token_2022_interface::ID)]
    pub token_2022: UncheckedAccount<'info>,
    /// CHECK: pinned to mint owner and allowlisted SPL program.
    #[account(address=*quote_mint.owner)]
    pub quote_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
pub fn create(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
    let a = ctx.accounts;
    let clock = Clock::get()?;
    require!(a.board.line_open, GateError::LineClosed);
    require!(
        args.total_supply > 0 && args.open_price > 0 && args.quoter != Pubkey::default(),
        GateError::InvalidConfig
    );
    require!(
        args.deployer_fee_bps <= 500 && args.platform_fee_share_bps <= 10_000,
        GateError::BoundsOutOfRange
    );
    validate_market_rules(args.bounds, args.limits, args.batch_len_slots)?;
    require_eligible(
        &a.config,
        &a.participant,
        &a.wallet_binding,
        &a.badge.as_badge_accounts(),
        clock.unix_timestamp,
        GateMode::Admission,
    )?;
    let base = a.base_mint.key();
    let quote = a.quote_mint.key();
    let participant = a.participant.key();
    let market = a.market.key();
    let market_seeds: &[&[u8]] = &[b"market", base.as_ref(), &[ctx.bumps.market]];
    let system = a.system_program.to_account_info();
    let payer = a.wallet.to_account_info();
    let authority = a.market.to_account_info();
    tokens::init_mint(
        &payer,
        &a.base_mint,
        &authority,
        &a.token_2022,
        &system,
        &[
            b"mint",
            participant.as_ref(),
            &a.board.markets_created.to_le_bytes(),
            &[ctx.bumps.base_mint],
        ],
        market_seeds,
        args.name,
        args.symbol,
        args.uri,
    )?;
    tokens::init_vault(
        &payer,
        &a.base_vault,
        &a.base_mint,
        &market,
        &a.token_2022,
        &system,
        &[
            b"vault",
            market.as_ref(),
            base.as_ref(),
            &[ctx.bumps.base_vault],
        ],
    )?;
    tokens::init_vault(
        &payer,
        &a.quote_vault,
        &a.quote_mint,
        &market,
        &a.quote_program,
        &system,
        &[
            b"vault",
            market.as_ref(),
            quote.as_ref(),
            &[ctx.bumps.quote_vault],
        ],
    )?;
    tokens::issue(
        &a.base_mint,
        &a.base_vault,
        &authority,
        &a.token_2022,
        market_seeds,
        args.total_supply,
    )?;
    let fee = a.board.launch_fee;
    let (_, quote_amount) = tokens::move_exact(
        &a.quote_mint,
        &a.wallet_quote,
        &payer,
        &a.quote_vault,
        &market,
        &a.quote_program,
        &[],
        fee,
    )?;
    let seed = (u128::from(fee) * u128::from(a.board.launch_fee_maker_share_bps) / 10_000) as u64;
    a.market.set_inner(Market {
        version: 1,
        bump: ctx.bumps.market,
        base_mint: base,
        quote_mint: quote,
        base_vault: a.base_vault.key(),
        quote_vault: a.quote_vault.key(),
        deployer: participant,
        quoter: args.quoter,
        created_at: clock.unix_timestamp,
        created_slot: clock.slot,
        total_supply: args.total_supply,
        stage: Stage::Line,
        stage_changed_at: clock.unix_timestamp,
        batch_id: 0,
        last_settled_batch: None,
        last_price: args.open_price,
        batch_len_slots: args.batch_len_slots,
        open_price: args.open_price,
        settling: false,
        maker_quote: seed.try_into().map_err(|_| GateError::Overflow)?,
        maker_fee_income: 0,
        maker_trading_quote: 0,
        maker_base: args.total_supply,
        risk_allowance: 0,
        risk_drawn_peak: 0,
        platform_fees: fee - seed,
        deployer_fees: 0,
        deployer_fee_bps: args.deployer_fee_bps,
        platform_fee_share_bps: args.platform_fee_share_bps,
        total_user_quote: 0,
        total_user_base: 0,
        bounds: args.bounds,
        limits: args.limits,
        final_reserve_quote: 0,
        swept: false,
    });
    let base_amount = crate::assets::inspect_token(
        &a.base_mint,
        &a.base_vault,
        a.token_2022.key,
        &base,
        &market,
    )?
    .amount;
    a.market.check_backing(true, base_amount)?;
    a.market.check_backing(false, quote_amount)?;
    a.board.markets_created = checked_credit(a.board.markets_created, 1)?;
    emit!(MarketCreated {
        market,
        base_mint: base,
        quote_mint: quote,
        deployer: participant,
        total_supply: args.total_supply,
        open_price: args.open_price,
        launch_fee: fee,
        maker_quote: seed,
        deployer_fee_bps: args.deployer_fee_bps,
        platform_fee_share_bps: args.platform_fee_share_bps,
        bounds: args.bounds,
        limits: args.limits
    });
    Ok(())
}
