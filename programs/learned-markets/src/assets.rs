//! Read-only snapshots for native SOL and SPL token balances.

use anchor_lang::{prelude::*, solana_program::program_pack::Pack};
use spl_token_2022_interface::{
    extension::{
        AccountType, BaseState, BaseStateWithExtensions, ExtensionType, Length, StateWithExtensions,
    },
    state::{Account as Token2022Account, Mint as Token2022Mint, Multisig},
};
use spl_token_interface::state::{Account as ClassicAccount, Mint as ClassicMint};
use spl_token_metadata_interface::state::TokenMetadata;

use crate::{error::GateError, references::require_data_account};

#[derive(Debug, PartialEq, Eq)]
pub struct SolBalance {
    pub address: Pubkey,
    pub owner: Pubkey,
    pub executable: bool,
    pub lamports: u64,
}

/// Observe lamports on any supplied account without a signature. Callers
/// establish the expected address and ownership when those properties matter.
pub fn inspect_sol(account: &AccountInfo<'_>) -> Result<SolBalance> {
    let lamports = account
        .try_borrow_lamports()
        .map_err(|_| GateError::AccountBorrowFailed)?;
    Ok(SolBalance {
        address: *account.key,
        owner: *account.owner,
        executable: account.executable,
        lamports: **lamports,
    })
}

#[derive(Debug, PartialEq)]
pub struct TokenBalance {
    pub token_program: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub authority: Pubkey,
    pub amount: u64,
    pub decimals: u8,
    pub frozen: bool,
    pub mint_extensions: Vec<ExtensionType>,
    pub account_extensions: Vec<ExtensionType>,
}

/// Verify the program, mint, and token-account authority against trusted values.
/// If a specific token-account address matters, the caller must bind that
/// address separately. Frozen holdings are reported. Amount is the raw base
/// balance, and extension identifiers describe layout rather than spendability,
/// delegated authority, or transfer proceeds.
pub fn inspect_token(
    mint: &AccountInfo<'_>,
    account: &AccountInfo<'_>,
    expected_program: &Pubkey,
    expected_mint: &Pubkey,
    expected_authority: &Pubkey,
) -> Result<TokenBalance> {
    let classic = expected_program.to_bytes() == spl_token_interface::ID.to_bytes();
    require!(
        classic || expected_program == &spl_token_2022_interface::ID,
        GateError::UnsupportedTokenProgram
    );
    require_keys_eq!(*mint.key, *expected_mint, GateError::TokenMintMismatch);
    require_data_account(mint, expected_program)?;
    require_data_account(account, expected_program)?;
    let mint_data = mint
        .try_borrow_data()
        .map_err(|_| GateError::AccountBorrowFailed)?;
    let account_data = account
        .try_borrow_data()
        .map_err(|_| GateError::AccountBorrowFailed)?;

    let (mint_key, authority, amount, decimals, frozen, mint_extensions, account_extensions) =
        if classic {
            let mint = ClassicMint::unpack(&mint_data).map_err(|_| GateError::InvalidTokenMint)?;
            let account = ClassicAccount::unpack(&account_data)
                .map_err(|_| GateError::InvalidTokenAccount)?;
            (
                account.mint.to_bytes(),
                account.owner.to_bytes(),
                account.amount,
                mint.decimals,
                account.is_frozen(),
                Vec::new(),
                Vec::new(),
            )
        } else {
            let mint = StateWithExtensions::<Token2022Mint>::unpack(&mint_data)
                .map_err(|_| GateError::InvalidTokenMint)?;
            let account = StateWithExtensions::<Token2022Account>::unpack(&account_data)
                .map_err(|_| GateError::InvalidTokenAccount)?;
            (
                account.base.mint.to_bytes(),
                account.base.owner.to_bytes(),
                account.base.amount,
                mint.base.decimals,
                account.base.is_frozen(),
                extension_types(&mint)?,
                extension_types(&account)?,
            )
        };

    require_keys_eq!(
        Pubkey::new_from_array(mint_key),
        *expected_mint,
        GateError::TokenMintMismatch
    );
    require_keys_eq!(
        Pubkey::new_from_array(authority),
        *expected_authority,
        GateError::TokenAuthorityMismatch
    );
    Ok(TokenBalance {
        token_program: *expected_program,
        mint: *expected_mint,
        token_account: *account.key,
        authority: *expected_authority,
        amount,
        decimals,
        frozen,
        mint_extensions,
        account_extensions,
    })
}

fn extension_types<S: BaseState + Pack>(
    state: &StateWithExtensions<'_, S>,
) -> Result<Vec<ExtensionType>> {
    let types = state
        .get_extension_types()
        .map_err(|_| GateError::InvalidTokenExtensions)?;
    let mut remaining = state.get_tlv_data();
    let type_len = size_of::<ExtensionType>();
    let header_len = type_len + size_of::<Length>();
    let base_len = Token2022Account::LEN + size_of::<AccountType>();

    // SPL enumerates and bounds-checks the entries. Also check each entry's
    // location and payload length, which the enumeration alone does not check.
    for (index, kind) in types.iter().enumerate() {
        require!(
            kind.get_account_type() == S::ACCOUNT_TYPE && !types[..index].contains(kind),
            GateError::InvalidTokenExtensions
        );
        let length_bytes = remaining
            .get(type_len..header_len)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(GateError::InvalidTokenExtensions)?;
        let length = usize::from(u16::from_le_bytes(length_bytes));
        let (entry, rest) = remaining
            .split_at_checked(header_len + length)
            .ok_or(GateError::InvalidTokenExtensions)?;
        remaining = rest;
        if *kind == ExtensionType::TokenMetadata {
            TokenMetadata::try_from_slice(&entry[header_len..])
                .map_err(|_| GateError::InvalidTokenExtensions)?;
        } else {
            let account_len = ExtensionType::try_calculate_account_len::<S>(&[*kind])
                .map_err(|_| GateError::InvalidTokenExtensions)?;
            let actual_len = base_len + entry.len();
            // SPL pads a layout whose length would collide with multisig.
            let padded_len = if actual_len == Multisig::LEN {
                actual_len + type_len
            } else {
                actual_len
            };
            require_eq!(padded_len, account_len, GateError::InvalidTokenExtensions);
        }
    }
    Ok(types)
}
