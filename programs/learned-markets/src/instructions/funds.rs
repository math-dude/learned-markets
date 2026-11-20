use super::*;
use crate::{
    accounting::{checked_credit, checked_debit},
    assets::inspect_token,
    constants::*,
    error::GateError,
    events::{Deposited, Withdrawn},
    gate::{require_eligible, GateMode},
    instructions::SasBadge,
    market::*,
    state::*,
    tokens,
};
use anchor_lang::prelude::*;
use spl_token_2022_interface::extension::ExtensionType;

#[derive(Accounts)]
pub struct AssetTransfer<'info> {
    /// CHECK: bound to the selected market mint; base must be writable for pausing.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: bound to the selected market vault; owner and mint checked by inspect_token.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: owner and mint checked by inspect_token.
    #[account(mut)]
    pub wallet_token: UncheckedAccount<'info>,
    /// CHECK: allowlisted SPL program, must own the mint.
    #[account(address=*mint.owner)]
    pub token_program: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds=[CONFIG_SEED],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds=[PARTICIPANT_SEED,config.app_scope.as_bytes(),participant.participant_id.as_ref()],bump=participant.bump,
        constraint=wallet.key()==participant.current_wallet @ GateError::WalletNotCurrent)]
    pub participant: Account<'info, Participant>,
    #[account(seeds=[WALLET_BINDING_SEED,wallet.key().as_ref()],bump=wallet_binding.bump)]
    pub wallet_binding: Account<'info, WalletBinding>,
    pub badge: SasBadge<'info>,
    /// Same as wallet for ordinary deposits. A retired wallet can co-sign to return withdrawn base after rotation.
    pub token_authority: Signer<'info>,
    #[account(seeds=[WALLET_BINDING_SEED,token_authority.key().as_ref()],bump=source_binding.bump,has_one=participant @ GateError::WalletNotCurrent)]
    pub source_binding: Account<'info, WalletBinding>,
    #[account(mut,seeds=[b"market",market.base_mint.as_ref()],bump=market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init_if_needed,payer=wallet,space=8+Position::INIT_SPACE,seeds=[b"position",market.key().as_ref(),participant.key().as_ref()],bump)]
    pub position: Account<'info, Position>,
    pub asset: AssetTransfer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds=[CONFIG_SEED],bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds=[PARTICIPANT_SEED,config.app_scope.as_bytes(),participant.participant_id.as_ref()],bump=participant.bump,
        constraint=wallet.key()==participant.current_wallet @ GateError::WalletNotCurrent)]
    pub participant: Account<'info, Participant>,
    #[account(mut,seeds=[b"market",market.base_mint.as_ref()],bump=market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut,seeds=[b"position",market.key().as_ref(),participant.key().as_ref()],bump=position.bump)]
    pub position: Account<'info, Position>,
    pub asset: AssetTransfer<'info>,
}
pub fn deposit(ctx: Context<Deposit>, amount: u64, base: bool) -> Result<()> {
    let a = ctx.accounts;
    require_eligible(
        &a.config,
        &a.participant,
        &a.wallet_binding,
        &a.badge.as_badge_accounts(),
        Clock::get()?.unix_timestamp,
        GateMode::Admission,
    )?;
    // A market in settlement has transient liabilities. Deposits wait for finalization.
    require!(!a.market.settling, GateError::MarketSettling);
    let p = &mut a.position;
    if p.version == 0 {
        p.version = 1;
        p.bump = ctx.bumps.position;
        p.market = a.market.key();
        p.participant = a.participant.key();
    }
    let after = transfer(
        &a.asset,
        &a.market,
        &a.token_authority.to_account_info(),
        true,
        base,
        amount,
    )?;
    if base {
        p.external_base = checked_debit(p.external_base, amount)?;
        p.base = checked_credit(p.base, amount)?;
        a.market.total_user_base = checked_credit(a.market.total_user_base, amount)?;
    } else {
        p.quote = checked_credit(p.quote, amount)?;
        a.market.total_user_quote = checked_credit(a.market.total_user_quote, amount)?;
    }
    a.market.check_backing(base, after)?;
    emit!(Deposited {
        market: a.market.key(),
        participant: a.participant.key(),
        asset: a.asset.mint.key(),
        amount
    });
    Ok(())
}
pub fn withdraw(ctx: Context<Withdraw>, amount: u64, base: bool) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.market.settling, GateError::MarketSettling);
    if base {
        a.position.base = checked_debit(a.position.base, amount)?;
        a.position.external_base = checked_credit(a.position.external_base, amount)?;
        a.market.total_user_base = checked_debit(a.market.total_user_base, amount)?;
    } else {
        a.position.quote = checked_debit(a.position.quote, amount)?;
        a.market.total_user_quote = checked_debit(a.market.total_user_quote, amount)?;
    }
    let after = transfer(
        &a.asset,
        &a.market,
        &a.wallet.to_account_info(),
        false,
        base,
        amount,
    )?;
    a.market.check_backing(base, after)?;
    emit!(Withdrawn {
        market: a.market.key(),
        participant: a.participant.key(),
        asset: a.asset.mint.key(),
        amount
    });
    Ok(())
}
fn transfer<'i>(
    asset: &AssetTransfer<'i>,
    market: &Account<'i, Market>,
    owner: &AccountInfo<'i>,
    deposit: bool,
    base: bool,
    amount: u64,
) -> Result<u64> {
    let (mint, vault) = if base {
        (market.base_mint, market.base_vault)
    } else {
        (market.quote_mint, market.quote_vault)
    };
    require_keys_eq!(asset.mint.key(), mint, GateError::TokenMintMismatch);
    require_keys_eq!(
        asset.vault.key(),
        vault,
        GateError::ReferenceAddressMismatch
    );
    let seeds: &[&[u8]] = &[b"market", market.base_mint.as_ref(), &[market.bump]];
    let market_info = market.to_account_info();
    if base {
        let wallet_account = inspect_token(
            &asset.mint,
            &asset.wallet_token,
            asset.token_program.key,
            &mint,
            owner.key,
        )?;
        require!(
            wallet_account
                .account_extensions
                .contains(&ExtensionType::ImmutableOwner),
            GateError::InvalidTokenAccount
        );
        tokens::set_pause(
            &asset.mint,
            &market_info,
            &asset.token_program,
            seeds,
            false,
        )?;
    }
    let after = if deposit {
        tokens::move_exact(
            &asset.mint,
            &asset.wallet_token,
            owner,
            &asset.vault,
            market_info.key,
            &asset.token_program,
            &[],
            amount,
        )?
        .1
    } else {
        tokens::move_exact(
            &asset.mint,
            &asset.vault,
            &market_info,
            &asset.wallet_token,
            owner.key,
            &asset.token_program,
            &[seeds],
            amount,
        )?
        .0
    };
    if base {
        tokens::set_pause(&asset.mint, &market_info, &asset.token_program, seeds, true)?;
    }
    Ok(after)
}
