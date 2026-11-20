//! Atomic simulation ledger. These PDAs contain accounting units and own no vaults.
use crate::{
    accounting::{checked_credit, checked_debit},
    constants::*,
    error::GateError,
    gate,
    instructions::*,
    payload::{Side, TradeContents},
    settlement::validate_trade_intent,
    state::*,
};
use anchor_lang::prelude::*;

pub const LEDGER_SUPPLY: u64 = 1_000_000_000;
pub const PRICE_SCALE: u128 = 1_000_000;
pub const BASE_FEE_BPS: u128 = 100;
pub const FEE_TO_BUCKET_PPM: u128 = 500_000;

#[account]
#[derive(InitSpace)]
pub struct LedgerMarket {
    pub version: u8,
    pub bump: u8,
    pub market_id: Pubkey,
    pub deployer: Pubkey,
    pub reserve_cash: u64,
    pub reserve_tokens: u64,
    pub last_batch_id: Option<u64>,
    pub last_price: u64,
    pub live: bool,
}
#[account]
#[derive(InitSpace)]
pub struct LedgerPlatform {
    pub version: u8,
    pub bump: u8,
    pub cash: u64,
}
#[account]
#[derive(InitSpace)]
pub struct LedgerBalance {
    pub version: u8,
    pub bump: u8,
    pub participant: Pubkey,
    pub cash: u64,
}
#[account]
#[derive(InitSpace)]
pub struct LedgerPosition {
    pub version: u8,
    pub bump: u8,
    pub market: Pubkey,
    pub participant: Pubkey,
    pub tokens: u64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LedgerFill {
    pub intent: Pubkey,
    pub contents: Vec<u8>,
    pub quantity: u64,
    pub fee_rate_ppm: u32,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LedgerSettlementRequest {
    pub market: Pubkey,
    pub batch_id: u64,
    pub clearing_price: u64,
    pub quoter_buy: u64,
    pub quoter_sell: u64,
    pub intents: Vec<LedgerFill>,
}

#[derive(Accounts)]
pub struct CreditLedgerBalance<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[CONFIG_SEED],bump=config.bump,has_one=admin @ GateError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(seeds=[PARTICIPANT_SEED,config.app_scope.as_bytes(),participant.participant_id.as_ref()],bump=participant.bump)]
    pub participant: Account<'info, Participant>,
    #[account(init_if_needed,payer=admin,seeds=[b"ledger-balance",participant.key().as_ref()],bump,space=8+LedgerBalance::INIT_SPACE)]
    pub balance: Account<'info, LedgerBalance>,
    pub system_program: Program<'info, System>,
}
pub fn credit(ctx: Context<CreditLedgerBalance>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    require!(
        cfg!(feature = "demo-credit") && matches!(a.config.network.as_str(), "localnet" | "surfpool" | "devnet"),
        GateError::LedgerCreditDisabled
    );
    a.balance.version = 1;
    a.balance.bump = ctx.bumps.balance;
    a.balance.participant = a.participant.key();
    a.balance.cash = checked_credit(a.balance.cash, amount)?;
    Ok(())
}
#[derive(Accounts)]
#[instruction(market_id:Pubkey)]
pub struct OpenLedgerMarket<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    pub settlement_authority: Signer<'info>,
    #[account(seeds=[CONFIG_SEED],bump=config.bump,has_one=settlement_authority @ GateError::NotSettlementAuthority)]
    pub config: Account<'info, Config>,
    #[account(seeds=[PARTICIPANT_SEED,config.app_scope.as_bytes(),participant.participant_id.as_ref()],bump=participant.bump,
        constraint=wallet.key()==participant.current_wallet @ GateError::WalletNotCurrent)]
    pub participant: Account<'info, Participant>,
    #[account(mut,seeds=[b"ledger-balance",participant.key().as_ref()],bump=balance.bump,has_one=participant)]
    pub balance: Account<'info, LedgerBalance>,
    #[account(init,payer=wallet,seeds=[b"ledger-market",market_id.as_ref()],bump,space=8+LedgerMarket::INIT_SPACE)]
    pub market: Account<'info, LedgerMarket>,
    #[account(init_if_needed,payer=wallet,seeds=[b"ledger-platform"],bump,space=8+LedgerPlatform::INIT_SPACE)]
    pub platform: Account<'info, LedgerPlatform>,
    pub system_program: Program<'info, System>,
}
pub fn open(ctx: Context<OpenLedgerMarket>, market_id: Pubkey, launch_fee: u64) -> Result<()> {
    let a = ctx.accounts;
    a.balance.cash = checked_debit(a.balance.cash, launch_fee)?;
    let reserve = launch_fee / 2;
    a.platform.version = 1;
    a.platform.bump = ctx.bumps.platform;
    a.platform.cash = checked_credit(a.platform.cash, launch_fee - reserve)?;
    a.market.set_inner(LedgerMarket {
        version: 1,
        bump: ctx.bumps.market,
        market_id,
        deployer: a.participant.key(),
        reserve_cash: reserve,
        reserve_tokens: LEDGER_SUPPLY,
        last_batch_id: None,
        last_price: 0,
        live: true,
    });
    Ok(())
}
#[derive(Accounts)]
pub struct CloseLedgerMarket<'info> {
    pub settlement_authority: Signer<'info>,
    #[account(seeds=[CONFIG_SEED],bump=config.bump,has_one=settlement_authority @ GateError::NotSettlementAuthority)]
    pub config: Account<'info, Config>,
    #[account(mut,seeds=[b"ledger-market",market.market_id.as_ref()],bump=market.bump)]
    pub market: Account<'info, LedgerMarket>,
    #[account(mut,seeds=[b"ledger-platform"],bump=platform.bump)]
    pub platform: Account<'info, LedgerPlatform>,
}
/// Most survivors a single close can pay. Bounds compute and transaction size.
pub const MAX_CLOSE_SURVIVORS: usize = 8;
pub const CLOSE_SURVIVOR_BPS: u128 = 6_000;
pub const CLOSE_DEPLOYER_BPS: u128 = 2_000;
/// Split a closed market's reserve. Returns (per survivor, per deployer, platform).
/// Survivors share 60% equally, their deployers 20%; the platform gets the rest,
/// including all rounding dust, or everything when nobody survives.
pub fn close_split(total: u64, survivors: usize) -> (u64, u64, u64) {
    if survivors == 0 {
        return (0, 0, total);
    }
    let n = survivors as u128;
    let each = (u128::from(total) * CLOSE_SURVIVOR_BPS / 10_000 / n) as u64;
    let dep = (u128::from(total) * CLOSE_DEPLOYER_BPS / 10_000 / n) as u64;
    // each*n <= 60% and dep*n <= 20% of total, so this cannot underflow.
    let platform = total - (each + dep) * survivors as u64;
    (each, dep, platform)
}
/// Remaining accounts: pairs of [survivor LedgerMarket (mut), its deployer's LedgerBalance (mut)].
pub fn close<'i>(ctx: Context<'i, CloseLedgerMarket<'i>>) -> Result<()> {
    let a = ctx.accounts;
    require!(a.market.live, GateError::MarketClosed);
    let rest = ctx.remaining_accounts;
    require!(
        rest.len() % 2 == 0 && rest.len() / 2 <= MAX_CLOSE_SURVIVORS,
        GateError::InvalidSurvivor
    );
    let closing = a.market.key();
    let mut survivors: Vec<Account<'i, LedgerMarket>> = Vec::with_capacity(rest.len() / 2);
    // One deployer can own several survivors; load each balance once so writes don't clobber.
    let mut balances: Vec<Account<'i, LedgerBalance>> = Vec::new();
    let mut payees: Vec<usize> = Vec::with_capacity(rest.len() / 2);
    for pair in rest.chunks_exact(2) {
        require!(
            pair[0].owner == &crate::ID && pair[1].owner == &crate::ID && pair[0].is_writable && pair[1].is_writable,
            GateError::InvalidSurvivor
        );
        let survivor: Account<'i, LedgerMarket> = Account::try_from(&pair[0])?;
        let key = Pubkey::create_program_address(
            &[b"ledger-market", survivor.market_id.as_ref(), &[survivor.bump]],
            &crate::ID,
        )
        .map_err(|_| GateError::InvalidSurvivor)?;
        require!(
            survivor.key() == key
                && survivor.live
                && key != closing
                && !survivors.iter().any(|s| s.key() == key),
            GateError::InvalidSurvivor
        );
        let idx = match balances.iter().position(|b| b.key() == pair[1].key()) {
            Some(i) => i,
            None => {
                let balance: Account<'i, LedgerBalance> = Account::try_from(&pair[1])?;
                let bkey = Pubkey::create_program_address(
                    &[b"ledger-balance", balance.participant.as_ref(), &[balance.bump]],
                    &crate::ID,
                )
                .map_err(|_| GateError::InvalidSurvivor)?;
                require!(balance.key() == bkey, GateError::InvalidSurvivor);
                balances.push(balance);
                balances.len() - 1
            }
        };
        require!(
            balances[idx].participant == survivor.deployer,
            GateError::InvalidSurvivor
        );
        payees.push(idx);
        survivors.push(survivor);
    }
    let total = a.market.reserve_cash;
    let (each, dep, to_platform) = close_split(total, survivors.len());
    for (survivor, &idx) in survivors.iter_mut().zip(&payees) {
        survivor.reserve_cash = checked_credit(survivor.reserve_cash, each)?;
        balances[idx].cash = checked_credit(balances[idx].cash, dep)?;
    }
    a.platform.cash = checked_credit(a.platform.cash, to_platform)?;
    a.market.reserve_cash = 0;
    a.market.live = false;
    for survivor in &survivors {
        survivor.exit(&crate::ID)?;
    }
    for balance in &balances {
        balance.exit(&crate::ID)?;
    }
    let n = survivors.len() as u64;
    emit!(crate::events::LiquidityRedistributed {
        market: closing,
        total,
        to_survivors: each * n,
        to_deployers: dep * n,
        to_platform,
        survivors: survivors
            .iter()
            .zip(&payees)
            .map(|(s, &i)| crate::events::SurvivorShare {
                market: s.key(),
                deployer_balance: balances[i].key(),
            })
            .collect(),
    });
    Ok(())
}
#[derive(Accounts)]
pub struct InitializeLedgerPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds=[b"ledger-market",market.market_id.as_ref()],bump=market.bump)]
    pub market: Account<'info, LedgerMarket>,
    pub participant: Account<'info, Participant>,
    #[account(init,payer=payer,seeds=[b"ledger-position",market.key().as_ref(),participant.key().as_ref()],bump,space=8+LedgerPosition::INIT_SPACE)]
    pub position: Account<'info, LedgerPosition>,
    pub system_program: Program<'info, System>,
}
pub fn initialize_position(ctx: Context<InitializeLedgerPosition>) -> Result<()> {
    let a = ctx.accounts;
    require!(a.market.live, GateError::MarketClosed);
    a.position.set_inner(LedgerPosition {
        version: 1,
        bump: ctx.bumps.position,
        market: a.market.key(),
        participant: a.participant.key(),
        tokens: 0,
    });
    Ok(())
}
#[derive(Accounts)]
pub struct SettleLedgerBatch<'info> {
    pub settlement_authority: Signer<'info>,
    #[account(seeds=[CONFIG_SEED],bump=config.bump,has_one=settlement_authority @ GateError::NotSettlementAuthority)]
    pub config: Account<'info, Config>,
    #[account(mut,seeds=[b"ledger-market",market.market_id.as_ref()],bump=market.bump)]
    pub market: Account<'info, LedgerMarket>,
    #[account(mut,seeds=[b"ledger-platform"],bump=platform.bump)]
    pub platform: Account<'info, LedgerPlatform>,
    pub sas: SasBadgeShared<'info>,
}
pub fn step_quantity(curve: &TradeContents, p: u64) -> u64 {
    match curve.side {
        Side::Buy => curve.points.iter().find(|point| point.price >= p),
        Side::Sell => curve.points.iter().rev().find(|point| point.price <= p),
    }
    .map_or(0, |point| point.quantity)
}
pub fn fill_amounts(side: Side, qty: u64, price: u64, rate: u32) -> Result<(u64, u64)> {
    let product = u128::from(qty) * u128::from(price);
    let (gross, fee) = match side {
        Side::Buy => {
            let gross = product.div_ceil(PRICE_SCALE);
            // Narrow first: every persisted cash value is a u64.
            let gross = u64::try_from(gross).map_err(|_| GateError::Overflow)?;
            (gross, (u128::from(gross) * BASE_FEE_BPS).div_ceil(10_000))
        }
        Side::Sell => {
            require!(
                (10_000..=250_000).contains(&rate),
                GateError::LedgerFeeRateOutOfRange
            );
            let gross = u64::try_from(product / PRICE_SCALE).map_err(|_| GateError::Overflow)?;
            (
                gross,
                (u128::from(gross) * u128::from(rate))
                    .div_ceil(1_000_000)
                    .min(u128::from(gross)),
            )
        }
    };
    Ok((gross, fee.try_into().map_err(|_| GateError::Overflow)?))
}
#[event]
pub struct LedgerBatchSettled {
    pub market: Pubkey,
    pub batch_id: u64,
    pub clearing_price: u64,
    pub user_bought: u64,
    pub user_sold: u64,
    pub fees: u64,
    pub reserve_cash: u64,
    pub reserve_tokens: u64,
    pub platform_cash: u64,
}
pub fn settle<'i>(
    ctx: Context<'i, SettleLedgerBatch<'i>>,
    request: LedgerSettlementRequest,
) -> Result<()> {
    let a = ctx.accounts;
    require!(a.market.live, GateError::MarketClosed);
    require_keys_eq!(
        a.market.key(),
        request.market,
        GateError::IntentTargetMismatch
    );
    require!(
        request.clearing_price > 0 && request.intents.len() <= MAX_SETTLEMENT_INTENTS,
        GateError::MalformedSettlementRequest
    );
    require!(
        a.market
            .last_batch_id
            .is_none_or(|prev| request.batch_id > prev),
        GateError::WrongBatchId
    );
    require!(
        ctx.remaining_accounts.len() == request.intents.len() * 8,
        GateError::SettlementAccountsMismatch
    );
    gate::check_config(&a.config)?;
    let now = Clock::get()?.unix_timestamp;
    let mut seen = Vec::with_capacity(request.intents.len());
    let (mut user_bought, mut user_sold) = (0u64, 0u64);
    let (mut paid, mut received, mut fees) = (0u128, 0u128, 0u128);
    for (fill, acc) in request
        .intents
        .iter()
        .zip(ctx.remaining_accounts.chunks_exact(8))
    {
        let (mut intent, participant, curve) = validate_trade_intent(
            &a.config,
            &a.sas,
            acc,
            fill.intent,
            request.market,
            &fill.contents,
            now,
        )?;
        require!(
            !seen.contains(&participant),
            GateError::DuplicateParticipantInChunk
        );
        seen.push(participant);
        require!(
            fill.quantity > 0 && fill.quantity <= step_quantity(&curve, request.clearing_price),
            GateError::InvalidLedgerFill
        );
        let mut balance: Account<'i, LedgerBalance> = Account::try_from(&acc[6])?;
        let mut pos: Account<'i, LedgerPosition> = Account::try_from(&acc[7])?;
        require!(
            balance.participant == participant
                && pos.participant == participant
                && pos.market == request.market,
            GateError::SettlementAccountsMismatch
        );
        let balance_key = Pubkey::create_program_address(
            &[b"ledger-balance", participant.as_ref(), &[balance.bump]],
            &crate::ID,
        )
        .map_err(|_| GateError::SettlementAccountsMismatch)?;
        let position_key = Pubkey::create_program_address(
            &[
                b"ledger-position",
                request.market.as_ref(),
                participant.as_ref(),
                &[pos.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| GateError::SettlementAccountsMismatch)?;
        require!(
            balance.key() == balance_key && pos.key() == position_key,
            GateError::SettlementAccountsMismatch
        );
        let (gross, fee) = fill_amounts(
            curve.side,
            fill.quantity,
            request.clearing_price,
            fill.fee_rate_ppm,
        )?;
        match curve.side {
            Side::Buy => {
                balance.cash = checked_debit(balance.cash, checked_credit(gross, fee)?)?;
                pos.tokens = checked_credit(pos.tokens, fill.quantity)?;
                user_bought = checked_credit(user_bought, fill.quantity)?;
                paid += u128::from(gross);
            }
            Side::Sell => {
                pos.tokens = checked_debit(pos.tokens, fill.quantity)?;
                balance.cash = checked_credit(balance.cash, gross - fee)?;
                user_sold = checked_credit(user_sold, fill.quantity)?;
                received += u128::from(gross);
            }
        }
        fees += u128::from(fee);
        intent.state = IntentState::Consumed;
        balance.exit(&crate::ID)?;
        pos.exit(&crate::ID)?;
        intent.exit(&crate::ID)?;
    }
    require!(
        u128::from(user_bought) + u128::from(request.quoter_buy)
            == u128::from(user_sold) + u128::from(request.quoter_sell),
        GateError::LedgerTokenMismatch
    );
    let reserve_tokens = (u128::from(a.market.reserve_tokens) + u128::from(request.quoter_buy))
        .checked_sub(u128::from(request.quoter_sell))
        .ok_or(GateError::MakerInventoryExceeded)?;
    let bucket = fees * FEE_TO_BUCKET_PPM / 1_000_000;
    let reserve_cash = (u128::from(a.market.reserve_cash) + paid + bucket)
        .checked_sub(received)
        .ok_or(GateError::MakerBudgetExceeded)?;
    a.market.reserve_tokens = reserve_tokens.try_into().map_err(|_| GateError::Overflow)?;
    a.market.reserve_cash = reserve_cash.try_into().map_err(|_| GateError::Overflow)?;
    a.platform.cash = (u128::from(a.platform.cash) + fees - bucket)
        .try_into()
        .map_err(|_| GateError::Overflow)?;
    a.market.last_batch_id = Some(request.batch_id);
    a.market.last_price = request.clearing_price;
    emit!(LedgerBatchSettled {
        market: request.market,
        batch_id: request.batch_id,
        clearing_price: request.clearing_price,
        user_bought,
        user_sold,
        fees: fees.try_into().map_err(|_| GateError::Overflow)?,
        reserve_cash: a.market.reserve_cash,
        reserve_tokens: a.market.reserve_tokens,
        platform_cash: a.platform.cash
    });
    Ok(())
}
