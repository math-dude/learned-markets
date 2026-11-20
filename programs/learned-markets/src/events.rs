use anchor_lang::prelude::*;

use crate::state::{IntentKind, ParticipantStatus};

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
