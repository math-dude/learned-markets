//! Read-only validation of typed account references.

use anchor_lang::prelude::*;

use crate::error::GateError;

/// Decode a Borsh-encoded Anchor account at an address obtained from trusted
/// state or canonical derivation. The type supplies the owner and discriminator.
/// The decoded value alone carries no application-specific relationship to a coin.
pub fn read_account<T>(account: &AccountInfo<'_>, expected_address: &Pubkey) -> Result<T>
where
    T: AnchorDeserialize + Discriminator + Owner,
{
    require_keys_eq!(
        *account.key,
        *expected_address,
        GateError::ReferenceAddressMismatch
    );
    require_data_account(account, &T::owner())?;
    let data = account
        .try_borrow_data()
        .map_err(|_| GateError::AccountBorrowFailed)?;
    require!(
        !T::DISCRIMINATOR.is_empty(),
        GateError::InvalidReferenceData
    );
    let mut payload = data
        .strip_prefix(T::DISCRIMINATOR)
        .ok_or(GateError::InvalidReferenceData)?;
    T::deserialize(&mut payload).map_err(|_| error!(GateError::InvalidReferenceData))
}

pub(crate) fn require_data_account(account: &AccountInfo<'_>, owner: &Pubkey) -> Result<()> {
    require!(!account.executable, GateError::ExecutableDataAccount);
    require_keys_eq!(*account.owner, *owner, GateError::DataAccountOwnerMismatch);
    Ok(())
}
