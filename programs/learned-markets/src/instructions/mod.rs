pub mod board;
pub mod funds;
pub mod launch;
pub use board::*;
pub use funds::*;
pub use launch::*;
pub mod admin;
pub mod intents;
pub mod registry;
pub mod settle;

pub use admin::*;
pub use intents::*;
pub use registry::*;
pub use settle::*;

use anchor_lang::prelude::*;

use crate::gate::BadgeAccounts;

/// SAS and Token-2022 accounts supplied to every protected instruction.
/// All are validated by the shared guard in `gate.rs`.
#[derive(Accounts)]
pub struct SasBadge<'info> {
    /// CHECK: validated by `gate::verify_badge` (owner, discriminator, trusted key).
    pub credential: UncheckedAccount<'info>,
    /// CHECK: validated by `gate::verify_badge` (owner, discriminator, trusted key, layout).
    pub schema: UncheckedAccount<'info>,
    /// CHECK: must equal `config.schema_mint`; checked by `gate::verify_badge`.
    pub schema_mint: UncheckedAccount<'info>,
    /// CHECK: SAS attestation; validated by `gate::verify_badge`.
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: Token-2022 badge mint; validated by `gate::verify_badge`.
    pub badge_mint: UncheckedAccount<'info>,
    /// CHECK: Token-2022 account holding the badge; validated by `gate::verify_badge`.
    pub badge_token_account: UncheckedAccount<'info>,
}

impl<'info> SasBadge<'info> {
    pub fn as_badge_accounts(&self) -> BadgeAccounts<'_, 'info> {
        BadgeAccounts {
            credential: self.credential.as_ref(),
            schema: self.schema.as_ref(),
            schema_mint: self.schema_mint.as_ref(),
            attestation: self.attestation.as_ref(),
            badge_mint: self.badge_mint.as_ref(),
            badge_token_account: self.badge_token_account.as_ref(),
        }
    }
}
