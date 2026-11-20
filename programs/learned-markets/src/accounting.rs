//! Pure arithmetic in integer base units of a single asset. Callers are
//! responsible for using a common asset and supplying trusted protections and
//! liabilities. These functions calculate values without reserving or moving funds.

use anchor_lang::prelude::*;

use crate::error::GateError;

/// Calculate a credit, failing on overflow.
pub fn checked_credit(balance: u64, amount: u64) -> Result<u64> {
    balance
        .checked_add(amount)
        .ok_or_else(|| error!(GateError::Overflow))
}

/// Calculate a debit, failing when the balance is insufficient.
pub fn checked_debit(balance: u64, amount: u64) -> Result<u64> {
    balance
        .checked_sub(amount)
        .ok_or_else(|| error!(GateError::InsufficientBalance))
}

/// Calculate the amount above an explicitly supplied protection.
pub fn available_balance(balance: u64, protected: u64) -> Result<u64> {
    balance
        .checked_sub(protected)
        .ok_or_else(|| error!(GateError::ProtectedAmountExceedsBalance))
}

/// Compare availability against a requested amount, including exact matches.
pub fn has_sufficient_balance(balance: u64, protected: u64, requested: u64) -> Result<bool> {
    Ok(available_balance(balance, protected)? >= requested)
}

/// Return surplus backing, failing when supplied liabilities exceed backing.
pub fn reconcile_backing(backing: u64, liabilities: u64) -> Result<u64> {
    backing
        .checked_sub(liabilities)
        .ok_or_else(|| error!(GateError::BackingDeficit))
}
