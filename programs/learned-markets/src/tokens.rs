//! Validated SPL CPIs. Every custody transfer must move the exact requested amount.
use crate::{assets::inspect_token, error::GateError};
use anchor_lang::{
    prelude::*,
    solana_program::{program::invoke_signed, program_pack::Pack, system_instruction},
};
use spl_token_2022_interface::{
    extension::{
        metadata_pointer, pausable, BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction as token,
    state::{Account as TokenAccount, Mint},
};

pub fn valid_program(id: &Pubkey) -> Result<()> {
    require!(
        *id == spl_token_2022_interface::ID || id.to_bytes() == spl_token_interface::ID.to_bytes(),
        GateError::UnsupportedTokenProgram
    );
    Ok(())
}

// Allocate and assign separately to allow prefunded PDAs, including unsolicited lamports.
fn allocate<'i>(
    payer: &AccountInfo<'i>,
    account: &AccountInfo<'i>,
    system: &AccountInfo<'i>,
    owner: &Pubkey,
    len: usize,
    rent_len: usize,
    seeds: &[&[u8]],
) -> Result<()> {
    let missing = Rent::get()?
        .minimum_balance(rent_len)
        .saturating_sub(account.lamports());
    if missing > 0 {
        invoke_signed(
            &system_instruction::transfer(payer.key, account.key, missing),
            &[payer.clone(), account.clone(), system.clone()],
            &[],
        )?;
    }
    let infos = [account.clone(), system.clone()];
    invoke_signed(
        &system_instruction::allocate(account.key, len as u64),
        &infos,
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, owner),
        &infos,
        &[seeds],
    )?;
    Ok(())
}
pub fn init_mint<'i>(
    payer: &AccountInfo<'i>,
    mint: &AccountInfo<'i>,
    market: &AccountInfo<'i>,
    program: &AccountInfo<'i>,
    system: &AccountInfo<'i>,
    mint_seeds: &[&[u8]],
    market_seeds: &[&[u8]],
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    require_keys_eq!(
        *program.key,
        spl_token_2022_interface::ID,
        GateError::UnsupportedTokenProgram
    );
    require!(
        !name.is_empty()
            && name.len() <= 64
            && !symbol.is_empty()
            && symbol.len() <= 16
            && uri.len() <= 256,
        GateError::InvalidConfig
    );
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::MetadataPointer,
        ExtensionType::Pausable,
    ])?;
    // Token-2022 reallocates during metadata initialization. Pre-fund the TLV + Borsh payload.
    let metadata_len = 4 + 32 + 32 + 4 * 4 + name.len() + symbol.len() + uri.len();
    allocate(
        payer,
        mint,
        system,
        program.key,
        len,
        len + metadata_len,
        mint_seeds,
    )?;
    let infos = [mint.clone(), market.clone(), program.clone()];
    invoke_signed(
        &metadata_pointer::instruction::initialize(program.key, mint.key, None, Some(*mint.key))?,
        &infos,
        &[],
    )?;
    invoke_signed(
        &pausable::instruction::initialize(program.key, mint.key, market.key)?,
        &infos,
        &[],
    )?;
    invoke_signed(
        &token::initialize_mint2(program.key, mint.key, market.key, None, 6)?,
        &infos,
        &[],
    )?;
    invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            program.key,
            mint.key,
            market.key,
            mint.key,
            market.key,
            name,
            symbol,
            uri,
        ),
        &infos,
        &[market_seeds],
    )?;
    Ok(())
}
pub fn init_vault<'i>(
    payer: &AccountInfo<'i>,
    vault: &AccountInfo<'i>,
    mint: &AccountInfo<'i>,
    market: &Pubkey,
    program: &AccountInfo<'i>,
    system: &AccountInfo<'i>,
    seeds: &[&[u8]],
) -> Result<()> {
    valid_program(program.key)?;
    require_keys_eq!(*mint.owner, *program.key, GateError::InvalidTokenMint);
    let len = if program.key == &spl_token_2022_interface::ID {
        let data = mint.try_borrow_data()?;
        let mint_state = StateWithExtensions::<Mint>::unpack(&data)?;
        let extensions = mint_state.get_extension_types()?;
        #[allow(deprecated)]
        let required = ExtensionType::get_required_init_account_extensions(&extensions);
        ExtensionType::try_calculate_account_len::<TokenAccount>(&required)?
    } else {
        TokenAccount::LEN
    };
    allocate(payer, vault, system, program.key, len, len, seeds)?;
    invoke_signed(
        &token::initialize_account3(program.key, vault.key, mint.key, market)?,
        &[vault.clone(), mint.clone(), program.clone()],
        &[],
    )?;
    Ok(())
}
pub fn issue<'i>(
    mint: &AccountInfo<'i>,
    vault: &AccountInfo<'i>,
    market: &AccountInfo<'i>,
    program: &AccountInfo<'i>,
    seeds: &[&[u8]],
    supply: u64,
) -> Result<()> {
    let infos = [mint.clone(), vault.clone(), market.clone(), program.clone()];
    invoke_signed(
        &token::mint_to_checked(program.key, mint.key, vault.key, market.key, &[], supply, 6)?,
        &infos,
        &[seeds],
    )?;
    invoke_signed(
        &token::set_authority(
            program.key,
            mint.key,
            None,
            token::AuthorityType::MintTokens,
            market.key,
            &[],
        )?,
        &infos,
        &[seeds],
    )?;
    set_pause(mint, market, program, seeds, true)
}
pub fn set_pause<'i>(
    mint: &AccountInfo<'i>,
    market: &AccountInfo<'i>,
    program: &AccountInfo<'i>,
    seeds: &[&[u8]],
    paused: bool,
) -> Result<()> {
    let ix = if paused {
        pausable::instruction::pause
    } else {
        pausable::instruction::resume
    };
    invoke_signed(
        &ix(program.key, mint.key, market.key, &[])?,
        &[mint.clone(), market.clone(), program.clone()],
        &[seeds],
    )?;
    Ok(())
}
pub fn move_exact<'i>(
    mint: &AccountInfo<'i>,
    source: &AccountInfo<'i>,
    source_owner: &AccountInfo<'i>,
    dest: &AccountInfo<'i>,
    dest_owner: &Pubkey,
    program: &AccountInfo<'i>,
    seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<(u64, u64)> {
    require_keys_neq!(source.key(), dest.key(), GateError::TokenAuthorityMismatch);
    let from = inspect_token(mint, source, program.key, mint.key, source_owner.key)?;
    let to = inspect_token(mint, dest, program.key, mint.key, dest_owner)?;
    invoke_signed(
        &token::transfer_checked(
            program.key,
            source.key,
            mint.key,
            dest.key,
            source_owner.key,
            &[],
            amount,
            from.decimals,
        )?,
        &[
            source.clone(),
            mint.clone(),
            dest.clone(),
            source_owner.clone(),
            program.clone(),
        ],
        seeds,
    )?;
    let source_after = inspect_token(mint, source, program.key, mint.key, source_owner.key)?.amount;
    let dest_after = inspect_token(mint, dest, program.key, mint.key, dest_owner)?.amount;
    require!(
        from.amount.checked_sub(amount) == Some(source_after)
            && to.amount.checked_add(amount) == Some(dest_after),
        GateError::VaultInvariantViolated
    );
    Ok((source_after, dest_after))
}
