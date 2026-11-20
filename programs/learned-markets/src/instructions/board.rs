use crate::{constants::CONFIG_SEED, error::GateError, events::*, market::*, state::Config};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BoardArgs {
    pub auction_authority: Pubkey,
    pub board_authority: Pubkey,
    pub treasury: Pubkey,
    pub launch_quote_mint: Pubkey,
    pub launch_fee: u64,
    pub launch_fee_maker_share_bps: u16,
    pub line_open: bool,
}
#[derive(Accounts)]
pub struct InitializeBoard<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ GateError::NotDeploymentAuthority)]
    pub program: Program<'info, crate::program::LearnedMarkets>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ GateError::NotDeploymentAuthority)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer=authority, space=8+BoardConfig::INIT_SPACE, seeds=[b"board"], bump)]
    pub board: Account<'info, BoardConfig>,
    pub system_program: Program<'info, System>,
}
pub fn init(ctx: Context<InitializeBoard>, args: BoardArgs) -> Result<()> {
    require!(
        args.launch_fee_maker_share_bps <= 10_000
            && [
                args.auction_authority,
                args.board_authority,
                args.treasury,
                args.launch_quote_mint
            ]
            .iter()
            .all(|k| *k != Pubkey::default()),
        GateError::InvalidConfig
    );
    ctx.accounts.board.set_inner(BoardConfig {
        version: 1,
        bump: ctx.bumps.board,
        auction_authority: args.auction_authority,
        board_authority: args.board_authority,
        treasury: args.treasury,
        launch_fee: args.launch_fee,
        launch_quote_mint: args.launch_quote_mint,
        launch_fee_maker_share_bps: args.launch_fee_maker_share_bps,
        line_open: args.line_open,
        markets_created: 0,
    });
    emit!(BoardInitialized {
        board: ctx.accounts.board.key(),
        auction_authority: args.auction_authority,
        board_authority: args.board_authority,
        treasury: args.treasury
    });
    Ok(())
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateBoardArgs {
    pub auction_authority: Option<Pubkey>,
    pub board_authority: Option<Pubkey>,
    pub treasury: Option<Pubkey>,
    pub launch_fee: Option<u64>,
    pub launch_fee_maker_share_bps: Option<u16>,
    pub line_open: Option<bool>,
}
#[derive(Accounts)]
pub struct UpdateBoard<'info> {
    pub authority: Signer<'info>,
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut,seeds=[b"board"], bump=board.bump)]
    pub board: Account<'info, BoardConfig>,
}
pub fn update(ctx: Context<UpdateBoard>, args: UpdateBoardArgs) -> Result<()> {
    let board = &mut ctx.accounts.board;
    let signer = ctx.accounts.authority.key();
    if args.launch_fee.is_some()
        || args.launch_fee_maker_share_bps.is_some()
        || args.line_open.is_some()
    {
        require_keys_eq!(
            signer,
            board.auction_authority,
            GateError::NotAuctionAuthority
        );
        if let Some(fee) = args.launch_fee {
            board.launch_fee = fee;
        }
        if let Some(share) = args.launch_fee_maker_share_bps {
            require!(share <= 10_000, GateError::BoundsOutOfRange);
            board.launch_fee_maker_share_bps = share;
        }
        if let Some(open) = args.line_open {
            board.line_open = open;
        }
    }
    if args.auction_authority.is_some() || args.board_authority.is_some() || args.treasury.is_some()
    {
        require_keys_eq!(signer, ctx.accounts.config.admin, GateError::NotAdmin);
        for key in [args.auction_authority, args.board_authority, args.treasury]
            .into_iter()
            .flatten()
        {
            require!(key != Pubkey::default(), GateError::InvalidConfig);
        }
        if let Some(key) = args.auction_authority {
            board.auction_authority = key;
        }
        if let Some(key) = args.board_authority {
            board.board_authority = key;
        }
        if let Some(key) = args.treasury {
            board.treasury = key;
        }
    }
    emit!(BoardUpdated {
        board: board.key(),
        launch_fee: board.launch_fee,
        line_open: board.line_open
    });
    Ok(())
}
#[derive(Accounts)]
pub struct SetStage<'info> {
    pub board_authority: Signer<'info>,
    #[account(seeds=[b"board"], bump=board.bump,has_one=board_authority @ GateError::NotBoardAuthority)]
    pub board: Account<'info, BoardConfig>,
    #[account(mut,seeds=[b"market",market.base_mint.as_ref()],bump=market.bump)]
    pub market: Account<'info, Market>,
}
pub fn stage(ctx: Context<SetStage>, stage: Stage) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(!market.settling, GateError::MarketSettling);
    require!(
        market.stage.can_transition(stage),
        GateError::InvalidStageTransition
    );
    market.stage = stage;
    market.stage_changed_at = Clock::get()?.unix_timestamp;
    if !stage.tradeable() {
        market.final_reserve_quote = market.maker_quote.max(0) as u64;
    }
    emit!(StageChanged {
        market: market.key(),
        stage,
        final_reserve_quote: market.final_reserve_quote
    });
    Ok(())
}
