use crate::{accounting::reconcile_backing, error::GateError};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Line,
    Rookie,
    Regular,
    Cut,
    Dead,
}
impl Stage {
    pub fn tradeable(self) -> bool {
        matches!(self, Self::Line | Self::Rookie | Self::Regular)
    }
    pub fn seated(self) -> bool {
        matches!(self, Self::Rookie | Self::Regular)
    }
    pub fn can_transition(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Line, Self::Rookie | Self::Cut)
                | (Self::Rookie, Self::Regular | Self::Cut | Self::Dead)
                | (Self::Regular, Self::Dead)
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq)]
pub struct TermsBounds {
    pub max_total_fee_bps: u16,
    pub max_hold_secs: u32,
    pub min_cap_bps: u16,
    pub max_cap_bps: u16,
    pub rookie_max_cap_bps: u16,
    pub max_per_person_batch_max: u64,
}
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq)]
pub struct MakerLimits {
    pub max_net_sell_per_batch: u64,
    pub max_net_buy_per_batch: u64,
    pub max_price_move_bps: u16,
    pub rookie_max_price_move_bps: u16,
}
pub fn validate_market_rules(bounds: TermsBounds, limits: MakerLimits, slots: u32) -> Result<()> {
    require!(
        bounds.max_total_fee_bps <= 2_000
            && bounds.min_cap_bps <= bounds.rookie_max_cap_bps
            && bounds.rookie_max_cap_bps <= bounds.max_cap_bps
            && bounds.max_cap_bps <= 1_000,
        GateError::BoundsOutOfRange
    );
    require!(
        slots >= 2
            && limits.max_price_move_bps <= 10_000
            && limits.rookie_max_price_move_bps <= 10_000,
        GateError::LimitsOutOfRange
    );
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct BoardConfig {
    pub version: u8,
    pub bump: u8,
    pub auction_authority: Pubkey,
    pub board_authority: Pubkey,
    pub treasury: Pubkey,
    pub launch_fee: u64,
    pub launch_quote_mint: Pubkey,
    pub launch_fee_maker_share_bps: u16,
    pub line_open: bool,
    pub markets_created: u64,
}
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub version: u8,
    pub bump: u8,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub deployer: Pubkey,
    pub quoter: Pubkey,
    pub created_at: i64,
    pub created_slot: u64,
    pub total_supply: u64,
    pub stage: Stage,
    pub stage_changed_at: i64,
    pub batch_id: u64,
    pub last_settled_batch: Option<u64>,
    pub last_price: u64,
    pub batch_len_slots: u32,
    pub open_price: u64,
    pub settling: bool,
    pub maker_quote: i64,
    pub maker_fee_income: u64,
    pub maker_trading_quote: i64,
    pub maker_base: u64,
    pub risk_allowance: u64,
    pub risk_drawn_peak: u64,
    pub platform_fees: u64,
    pub deployer_fees: u64,
    pub deployer_fee_bps: u16,
    pub platform_fee_share_bps: u16,
    pub total_user_quote: u64,
    pub total_user_base: u64,
    pub bounds: TermsBounds,
    pub limits: MakerLimits,
    pub final_reserve_quote: u64,
    pub swept: bool,
}
impl Market {
    pub fn check_backing(&self, base: bool, amount: u64) -> Result<()> {
        let liabilities = if base {
            i128::from(self.total_user_base) + i128::from(self.maker_base)
        } else {
            i128::from(self.total_user_quote)
                + i128::from(self.platform_fees)
                + i128::from(self.deployer_fees)
                + i128::from(self.maker_quote)
                + i128::from(self.risk_allowance)
        };
        // SPL transfers directly to a vault create surplus; they must never block exits.
        reconcile_backing(
            amount,
            liabilities
                .try_into()
                .map_err(|_| GateError::VaultInvariantViolated)?,
        )
        .map_err(|_| error!(GateError::VaultInvariantViolated))?;
        Ok(())
    }
}
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub version: u8,
    pub bump: u8,
    pub market: Pubkey,
    pub participant: Pubkey,
    pub base: u64,
    pub external_base: u64,
    pub quote: u64,
    pub last_buy_ts: i64,
    pub batch_seen: u64,
    pub batch_bought: u64,
    pub batch_sold: u64,
    pub total_bought: u64,
    pub total_sold: u64,
    pub fees_paid: u64,
}
