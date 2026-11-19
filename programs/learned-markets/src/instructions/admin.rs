use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::GateError,
    events::ParticipantStatusChanged,
    sas,
    state::{Config, Participant, ParticipantStatus, CONFIG_VERSION},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct InitializeConfigArgs {
    pub app_scope: String,
    pub network: String,
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub credential_authority: Pubkey,
    pub schema_version: u8,
    pub allowed_verification_method: u8,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Must be the program's upgrade (deployment) authority.
    pub authority: Signer<'info>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ GateError::NotDeploymentAuthority
    )]
    pub program: Program<'info, crate::program::LearnedMarkets>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ GateError::NotDeploymentAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: decoded and validated in the handler (SAS owner, discriminator, authority).
    pub credential: UncheckedAccount<'info>,
    /// CHECK: decoded and validated in the handler (SAS owner, credential, layout, version).
    pub schema: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    args: InitializeConfigArgs,
) -> Result<()> {
    require!(args.app_scope == APP_SCOPE, GateError::InvalidConfig);
    require!(
        !args.network.is_empty() && args.network.len() <= MAX_NETWORK_LEN,
        GateError::InvalidConfig
    );
    require!(
        args.allowed_verification_method == VERIFICATION_METHOD_OPERATOR_APPROVED,
        GateError::InvalidConfig
    );
    require!(args.admin != Pubkey::default(), GateError::InvalidConfig);
    require!(
        args.settlement_authority != Pubkey::default(),
        GateError::InvalidConfig
    );

    let credential_info = ctx.accounts.credential.as_ref();
    let schema_info = ctx.accounts.schema.as_ref();
    let credential = sas::decode_credential(credential_info, &SAS_PROGRAM_ID)?;
    require_keys_eq!(
        credential.authority,
        args.credential_authority,
        GateError::UntrustedCredentialAuthority
    );
    let schema = sas::decode_schema(schema_info, &SAS_PROGRAM_ID)?;
    require_keys_eq!(
        schema.credential,
        credential_info.key(),
        GateError::UntrustedSchema
    );
    require!(
        schema.name.as_slice() == SCHEMA_NAME.as_bytes(),
        GateError::UntrustedSchema
    );
    require!(
        schema.version == args.schema_version,
        GateError::SchemaVersionMismatch
    );
    require!(
        schema.layout.as_slice() == SCHEMA_LAYOUT,
        GateError::SchemaLayoutMismatch
    );

    let (schema_mint, _) = Pubkey::find_program_address(
        &[SAS_SCHEMA_MINT_SEED, schema_info.key().as_ref()],
        &SAS_PROGRAM_ID,
    );
    let (sas_authority, _) = Pubkey::find_program_address(&[SAS_AUTHORITY_SEED], &SAS_PROGRAM_ID);

    let config = &mut ctx.accounts.config;
    config.set_inner(Config {
        version: CONFIG_VERSION,
        bump: ctx.bumps.config,
        app_scope: args.app_scope,
        network: args.network,
        admin: args.admin,
        settlement_authority: args.settlement_authority,
        sas_program: SAS_PROGRAM_ID,
        sas_authority,
        credential: credential_info.key(),
        credential_authority: args.credential_authority,
        schema: schema_info.key(),
        schema_version: args.schema_version,
        schema_mint,
        allowed_verification_method: args.allowed_verification_method,
        admission_paused: false,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Default)]
pub struct UpdateConfigArgs {
    pub admission_paused: Option<bool>,
    pub admin: Option<Pubkey>,
    pub settlement_authority: Option<Pubkey>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ GateError::NotAdmin
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    if let Some(paused) = args.admission_paused {
        config.admission_paused = paused;
    }
    if let Some(admin) = args.admin {
        require!(admin != Pubkey::default(), GateError::InvalidConfig);
        config.admin = admin;
    }
    if let Some(authority) = args.settlement_authority {
        require!(authority != Pubkey::default(), GateError::InvalidConfig);
        config.settlement_authority = authority;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct SetParticipantStatus<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ GateError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [PARTICIPANT_SEED, config.app_scope.as_bytes(), participant.participant_id.as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, Participant>,
}

pub fn handle_suspend_participant(ctx: Context<SetParticipantStatus>) -> Result<()> {
    let participant = &mut ctx.accounts.participant;
    require!(
        participant.status == ParticipantStatus::Active,
        GateError::ParticipantNotActive
    );
    participant.status = ParticipantStatus::Suspended;
    participant.updated_at = Clock::get()?.unix_timestamp;
    emit!(ParticipantStatusChanged {
        participant: participant.key(),
        status: participant.status,
    });
    Ok(())
}

pub fn handle_revoke_participant(ctx: Context<SetParticipantStatus>) -> Result<()> {
    let participant = &mut ctx.accounts.participant;
    require!(
        participant.status != ParticipantStatus::Revoked,
        GateError::ParticipantRevoked
    );
    participant.status = ParticipantStatus::Revoked;
    participant.updated_at = Clock::get()?.unix_timestamp;
    emit!(ParticipantStatusChanged {
        participant: participant.key(),
        status: participant.status,
    });
    Ok(())
}
