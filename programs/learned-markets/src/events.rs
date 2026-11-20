use anchor_lang::prelude::*;

use crate::state::{IntentKind, ParticipantStatus};

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub admission_paused: bool,
}

#[event]
pub struct ConfigUpdated {
    pub config: Pubkey,
    pub authorizing_admin: Pubkey,
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub admission_paused: bool,
}

#[event]
pub struct ParticipantRegistered {
    pub participant: Pubkey,
    pub participant_id: [u8; 32],
    pub wallet: Pubkey,
    pub attestation: Pubkey,
    pub binding_version: u32,
}

#[event]
pub struct ParticipantStatusChanged {
    pub participant: Pubkey,
    pub status: ParticipantStatus,
}

#[event]
pub struct BindingReplaced {
    pub participant: Pubkey,
    pub previous_wallet: Pubkey,
    pub wallet: Pubkey,
    pub attestation: Pubkey,
    pub binding_version: u32,
}

#[event]
pub struct IntentSubmitted {
    pub intent: Pubkey,
    pub participant: Pubkey,
    pub nonce: u64,
    pub kind: IntentKind,
    pub target: Pubkey,
    pub payload_hash: [u8; 32],
    pub deadline: i64,
}

#[event]
pub struct IntentCancelled {
    pub intent: Pubkey,
    pub participant: Pubkey,
    pub nonce: u64,
}

#[event]
pub struct BoardInitialized {
    pub board: Pubkey,
    pub auction_authority: Pubkey,
    pub board_authority: Pubkey,
    pub treasury: Pubkey,
}
#[event]
pub struct BoardUpdated {
    pub board: Pubkey,
    pub launch_fee: u64,
    pub line_open: bool,
}
#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub deployer: Pubkey,
    pub total_supply: u64,
    pub open_price: u64,
    pub launch_fee: u64,
    pub maker_quote: u64,
    pub deployer_fee_bps: u16,
    pub platform_fee_share_bps: u16,
    pub bounds: crate::market::TermsBounds,
    pub limits: crate::market::MakerLimits,
}
#[event]
pub struct StageChanged {
    pub market: Pubkey,
    pub stage: crate::market::Stage,
    pub final_reserve_quote: u64,
}
#[event]
pub struct Deposited {
    pub market: Pubkey,
    pub participant: Pubkey,
    pub asset: Pubkey,
    pub amount: u64,
}
#[event]
pub struct Withdrawn {
    pub market: Pubkey,
    pub participant: Pubkey,
    pub asset: Pubkey,
    pub amount: u64,
}
