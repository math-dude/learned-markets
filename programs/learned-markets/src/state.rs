use anchor_lang::prelude::*;

use crate::constants::{MAX_APP_SCOPE_LEN, MAX_NETWORK_LEN};

pub const CONFIG_VERSION: u8 = 1;
pub const PARTICIPANT_VERSION: u8 = 1;
pub const WALLET_BINDING_VERSION: u8 = 1;
pub const INTENT_VERSION: u8 = 1;

/// Registry configuration and SAS trust anchors. PDA: `["config"]`.
#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    #[max_len(MAX_APP_SCOPE_LEN)]
    pub app_scope: String,
    /// Network domain included in intent payload hashes (e.g. "devnet").
    #[max_len(MAX_NETWORK_LEN)]
    pub network: String,
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub sas_program: Pubkey,
    /// SAS `sas` PDA: mint authority, permanent delegate and group authority of badges.
    pub sas_authority: Pubkey,
    pub credential: Pubkey,
    pub credential_authority: Pubkey,
    pub schema: Pubkey,
    pub schema_version: u8,
    pub schema_mint: Pubkey,
    pub allowed_verification_method: u8,
    pub admission_paused: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ParticipantStatus {
    Active,
    Suspended,
    Revoked,
}

/// Stable participant record. PDA: `["participant", app_scope, participant_id]`.
/// Never closed: identity, history and the intent nonce sequence survive wallet replacement.
#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct Participant {
    pub version: u8,
    pub bump: u8,
    pub participant_id: [u8; 32],
    pub current_wallet: Pubkey,
    pub current_attestation: Pubkey,
    pub current_badge_mint: Pubkey,
    pub binding_version: u32,
    pub status: ParticipantStatus,
    pub next_intent_nonce: u64,
    pub registered_at: i64,
    pub updated_at: i64,
}

/// Wallet → participant association. PDA: `["wallet-binding", wallet]`.
/// Retained (inactive) after retirement so the wallet can never be bound to another participant.
#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct WalletBinding {
    pub version: u8,
    pub bump: u8,
    pub wallet: Pubkey,
    pub participant: Pubkey,
    pub participant_id: [u8; 32],
    pub active: bool,
    pub bound_at: i64,
    pub retired_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum IntentKind {
    Trade,
    Nomination,
}

impl IntentKind {
    pub fn code(self) -> u8 {
        match self {
            IntentKind::Trade => 0,
            IntentKind::Nomination => 1,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum IntentState {
    Open,
    Cancelled,
    Consumed,
}

/// Authenticated intent admission. PDA: `["intent", participant, nonce_le]`.
/// Does not reserve funds, guarantee a fill, or prove sufficient balance.
#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct Intent {
    pub version: u8,
    pub bump: u8,
    pub participant: Pubkey,
    pub wallet: Pubkey,
    pub binding_version: u32,
    pub nonce: u64,
    pub kind: IntentKind,
    pub target: Pubkey,
    pub payload_hash: [u8; 32],
    pub created_at: i64,
    pub deadline: i64,
    pub state: IntentState,
}
