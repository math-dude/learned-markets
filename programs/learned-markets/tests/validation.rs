use anchor_lang::{prelude::*, solana_program::program_pack::Pack};
use learned_markets::{accounting::*, assets::*, error::GateError, references::read_account, ID};
use spl_token_2022_interface::{
    extension::{
        immutable_owner::ImmutableOwner, mint_close_authority::MintCloseAuthority,
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    },
    state::{Account as Token2022Account, Mint as Token2022Mint},
};
use spl_token_interface::state::{Account as ClassicAccount, AccountState, Mint as ClassicMint};
use spl_token_metadata_interface::state::TokenMetadata;

#[account]
#[derive(Debug, PartialEq)]
struct ExampleAccount {
    value: u64,
}

#[track_caller]
fn expect_error<T: std::fmt::Debug>(result: Result<T>, expected: GateError) {
    match result.unwrap_err() {
        anchor_lang::error::Error::AnchorError(error) => {
            assert_eq!(error.error_code_number, u32::from(expected), "{error:?}");
        }
        error => panic!("unexpected error: {error:?}"),
    }
}

#[test]
fn typed_reference_checks_address_owner_executable_discriminator_and_layout() {
    let address = Pubkey::new_unique();
    let expected = Pubkey::new_unique();
    let other = Pubkey::new_unique();
    let owner = ExampleAccount::owner();
    let example = ExampleAccount { value: 10 };
    let mut bytes = Vec::new();
    example.try_serialize(&mut bytes).unwrap();
    let mut wrong_discriminator = bytes.clone();
    wrong_discriminator[0] ^= 1;

    let decode = |address, account_owner, executable, data: &[u8]| {
        let mut balance = 1;
        let mut data = data.to_vec();
        let info = AccountInfo::new(
            address,
            false,
            false,
            &mut balance,
            &mut data,
            account_owner,
            executable,
        );
        read_account::<ExampleAccount>(&info, &expected)
    };
    assert_eq!(decode(&expected, &owner, false, &bytes).unwrap(), example);
    expect_error(
        decode(&address, &owner, false, &bytes),
        GateError::ReferenceAddressMismatch,
    );
    expect_error(
        decode(&expected, &other, false, &bytes),
        GateError::DataAccountOwnerMismatch,
    );
    expect_error(
        decode(&expected, &owner, true, &bytes),
        GateError::ExecutableDataAccount,
    );
    expect_error(
        decode(&expected, &owner, false, &wrong_discriminator),
        GateError::InvalidReferenceData,
    );
    expect_error(
        decode(&expected, &owner, false, &bytes[..bytes.len() - 1]),
        GateError::InvalidReferenceData,
    );
}

#[test]
fn sol_snapshot_keeps_metadata_and_needs_no_signature() {
    let address = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let mut lamports = u64::MAX;
    let info = AccountInfo::new(&address, false, false, &mut lamports, &mut [], &owner, true);
    assert_eq!(
        inspect_sol(&info).unwrap(),
        SolBalance {
            address,
            owner,
            executable: true,
            lamports: u64::MAX
        }
    );
}

const MINT: Pubkey = Pubkey::new_from_array([11; 32]);
const WALLET: Pubkey = Pubkey::new_from_array([12; 32]);
const TOKEN_ACCOUNT: Pubkey = Pubkey::new_from_array([13; 32]);
const CLASSIC: Pubkey = Pubkey::new_from_array(spl_token_interface::ID.to_bytes());
const TOKEN_2022: Pubkey = spl_token_2022_interface::ID;

fn token_snapshot(
    mint_data: &[u8],
    account_data: &[u8],
    program: &Pubkey,
    account_owner: &Pubkey,
    mint_key: &Pubkey,
) -> Result<TokenBalance> {
    let mut mint_lamports = 1;
    let mut account_lamports = 1;
    let mut mint_data = mint_data.to_vec();
    let mut account_data = account_data.to_vec();
    let mint = AccountInfo::new(
        mint_key,
        false,
        false,
        &mut mint_lamports,
        &mut mint_data,
        program,
        false,
    );
    let account = AccountInfo::new(
        &TOKEN_ACCOUNT,
        false,
        false,
        &mut account_lamports,
        &mut account_data,
        account_owner,
        false,
    );
    inspect_token(&mint, &account, program, &MINT, &WALLET)
}

fn classic_data(
    mint: &ClassicMint,
    account: &ClassicAccount,
) -> ([u8; ClassicMint::LEN], [u8; ClassicAccount::LEN]) {
    let mut mint_data = [0; ClassicMint::LEN];
    let mut account_data = [0; ClassicAccount::LEN];
    ClassicMint::pack(*mint, &mut mint_data).unwrap();
    ClassicAccount::pack(*account, &mut account_data).unwrap();
    (mint_data, account_data)
}

#[test]
fn classic_token_checks_both_accounts_and_reports_frozen_balances() {
    let mut mint = ClassicMint {
        decimals: 6,
        is_initialized: true,
        ..Default::default()
    };
    let mut account = ClassicAccount {
        mint: MINT.to_bytes().into(),
        owner: WALLET.to_bytes().into(),
        amount: 42,
        state: AccountState::Frozen,
        ..Default::default()
    };
    let inspect = |mint: &ClassicMint, account: &ClassicAccount| {
        let (mint, account) = classic_data(mint, account);
        token_snapshot(&mint, &account, &CLASSIC, &CLASSIC, &MINT)
    };
    assert_eq!(
        inspect(&mint, &account).unwrap(),
        TokenBalance {
            token_program: CLASSIC,
            mint: MINT,
            token_account: TOKEN_ACCOUNT,
            authority: WALLET,
            amount: 42,
            decimals: 6,
            frozen: true,
            mint_extensions: vec![],
            account_extensions: vec![],
        }
    );
    let (mint_data, account_data) = classic_data(&mint, &account);
    expect_error(
        token_snapshot(
            &mint_data,
            &account_data,
            &CLASSIC,
            &CLASSIC,
            &TOKEN_ACCOUNT,
        ),
        GateError::TokenMintMismatch,
    );
    expect_error(
        token_snapshot(&mint_data, &account_data, &CLASSIC, &TOKEN_2022, &MINT),
        GateError::DataAccountOwnerMismatch,
    );
    expect_error(
        token_snapshot(&mint_data, &account_data, &WALLET, &WALLET, &MINT),
        GateError::UnsupportedTokenProgram,
    );
    expect_error(
        token_snapshot(
            &mint_data,
            &account_data[..ClassicAccount::LEN - 1],
            &CLASSIC,
            &CLASSIC,
            &MINT,
        ),
        GateError::InvalidTokenAccount,
    );
    mint.is_initialized = false;
    expect_error(inspect(&mint, &account), GateError::InvalidTokenMint);
    mint.is_initialized = true;
    account.state = AccountState::Uninitialized;
    expect_error(inspect(&mint, &account), GateError::InvalidTokenAccount);
    account.state = AccountState::Initialized;
    account.owner = TOKEN_ACCOUNT.to_bytes().into();
    expect_error(inspect(&mint, &account), GateError::TokenAuthorityMismatch);
    account.owner = WALLET.to_bytes().into();
    account.mint = TOKEN_ACCOUNT.to_bytes().into();
    expect_error(inspect(&mint, &account), GateError::TokenMintMismatch);
}

#[test]
fn token_2022_reports_extensions_and_rejects_malformed_buffers() {
    let mut mint = vec![0; 512];
    let mut mint_state =
        StateWithExtensionsMut::<Token2022Mint>::unpack_uninitialized(&mut mint).unwrap();
    mint_state
        .init_extension::<MintCloseAuthority>(false)
        .unwrap();
    mint_state
        .init_variable_len_extension(
            &TokenMetadata {
                mint: MINT,
                name: "Example".into(),
                ..Default::default()
            },
            false,
        )
        .unwrap();
    mint_state.base = Token2022Mint {
        is_initialized: true,
        decimals: 9,
        ..Default::default()
    };
    mint_state.pack_base();
    mint_state.init_account_type().unwrap();

    let account_len = ExtensionType::try_calculate_account_len::<Token2022Account>(&[
        ExtensionType::ImmutableOwner,
    ])
    .unwrap();
    let mut account = vec![0; account_len];
    let mut account_state =
        StateWithExtensionsMut::<Token2022Account>::unpack_uninitialized(&mut account).unwrap();
    account_state
        .init_extension::<ImmutableOwner>(false)
        .unwrap();
    account_state.base = Token2022Account {
        mint: MINT,
        owner: WALLET,
        amount: u64::MAX,
        state: spl_token_2022_interface::state::AccountState::Frozen,
        ..Default::default()
    };
    account_state.pack_base();
    account_state.init_account_type().unwrap();

    let inspect = |mint: &[u8], account: &[u8]| {
        token_snapshot(mint, account, &TOKEN_2022, &TOKEN_2022, &MINT)
    };
    let snapshot = inspect(&mint, &account).unwrap();
    assert_eq!(snapshot.amount, u64::MAX);
    assert_eq!(snapshot.decimals, 9);
    assert!(snapshot.frozen);
    assert_eq!(
        snapshot.mint_extensions,
        [
            ExtensionType::MintCloseAuthority,
            ExtensionType::TokenMetadata
        ]
    );
    assert_eq!(snapshot.account_extensions, [ExtensionType::ImmutableOwner]);
    assert!(inspect(
        &mint[..Token2022Mint::LEN],
        &account[..Token2022Account::LEN]
    )
    .unwrap()
    .mint_extensions
    .is_empty());

    let tlv = Token2022Account::LEN + 1;
    expect_error(
        inspect(&mint, &account[..account.len() - 1]),
        GateError::InvalidTokenExtensions,
    );
    let mut malformed = account.clone();
    malformed[tlv..tlv + 2].copy_from_slice(&u16::MAX.to_le_bytes());
    expect_error(
        inspect(&mint, &malformed),
        GateError::InvalidTokenExtensions,
    );
    malformed[tlv..tlv + 2]
        .copy_from_slice(&u16::from(ExtensionType::NonTransferable).to_le_bytes());
    expect_error(
        inspect(&mint, &malformed),
        GateError::InvalidTokenExtensions,
    );
    malformed[tlv..tlv + 2].copy_from_slice(&u16::from(ExtensionType::MemoTransfer).to_le_bytes());
    expect_error(
        inspect(&mint, &malformed),
        GateError::InvalidTokenExtensions,
    );
    malformed = account.clone();
    malformed.extend_from_slice(&account[tlv..]);
    expect_error(
        inspect(&mint, &malformed),
        GateError::InvalidTokenExtensions,
    );

    let close_authority_end = ExtensionType::try_calculate_account_len::<Token2022Mint>(&[
        ExtensionType::MintCloseAuthority,
    ])
    .unwrap();
    let mut malformed_metadata = mint.clone();
    // Metadata starts with two addresses, followed by the name's Borsh length.
    let name_length = close_authority_end + 4 + 64;
    malformed_metadata[name_length..name_length + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    expect_error(
        inspect(&malformed_metadata, &account),
        GateError::InvalidTokenExtensions,
    );

    let mut uninitialized_mint = mint.clone();
    Token2022Mint::pack(
        Token2022Mint::default(),
        &mut uninitialized_mint[..Token2022Mint::LEN],
    )
    .unwrap();
    expect_error(
        inspect(&uninitialized_mint, &account),
        GateError::InvalidTokenMint,
    );
    let mut uninitialized_account = account.clone();
    Token2022Account::pack(
        Token2022Account::default(),
        &mut uninitialized_account[..Token2022Account::LEN],
    )
    .unwrap();
    expect_error(
        inspect(&mint, &uninitialized_account),
        GateError::InvalidTokenAccount,
    );
    let mut wrong_authority = account.clone();
    let mut base = Token2022Account::unpack(&wrong_authority[..Token2022Account::LEN]).unwrap();
    base.owner = MINT;
    Token2022Account::pack(base, &mut wrong_authority[..Token2022Account::LEN]).unwrap();
    expect_error(
        inspect(&mint, &wrong_authority),
        GateError::TokenAuthorityMismatch,
    );
    base.owner = WALLET;
    base.mint = WALLET;
    Token2022Account::pack(base, &mut wrong_authority[..Token2022Account::LEN]).unwrap();
    expect_error(
        inspect(&mint, &wrong_authority),
        GateError::TokenMintMismatch,
    );
}

#[test]
fn accounting_checks_base_unit_boundaries() {
    assert_eq!(checked_credit(0, 0).unwrap(), 0);
    assert_eq!(checked_credit(u64::MAX - 1, 1).unwrap(), u64::MAX);
    expect_error(checked_credit(u64::MAX, 1), GateError::Overflow);
    assert_eq!(checked_debit(u64::MAX, u64::MAX).unwrap(), 0);
    expect_error(checked_debit(0, 1), GateError::InsufficientBalance);
    assert_eq!(available_balance(10, 3).unwrap(), 7);
    assert!(has_sufficient_balance(10, 3, 7).unwrap());
    assert!(has_sufficient_balance(0, 0, 0).unwrap());
    assert!(!has_sufficient_balance(10, 3, 8).unwrap());
    expect_error(
        has_sufficient_balance(2, 3, 0),
        GateError::ProtectedAmountExceedsBalance,
    );
    assert_eq!(reconcile_backing(u64::MAX, u64::MAX).unwrap(), 0);
    assert_eq!(reconcile_backing(10, 3).unwrap(), 7);
    expect_error(reconcile_backing(2, 3), GateError::BackingDeficit);
}

#[test]
fn close_split_conserves_cash_and_gives_dust_to_platform() {
    use learned_markets::ledger::close_split;
    assert_eq!(close_split(1_000, 0), (0, 0, 1_000));
    assert_eq!(close_split(50, 3), (10, 3, 11));
    for total in [0, 1, 7, 99, 1_001, 123_456_789, u64::MAX] {
        for n in 0..=8usize {
            let (each, dep, platform) = close_split(total, n);
            let paid = u128::from(each + dep) * n as u128 + u128::from(platform);
            assert_eq!(paid, u128::from(total), "total {total} n {n}");
            assert!(u128::from(platform) * 10 >= u128::from(total) * 2, "platform keeps >= 20%");
        }
    }
}
