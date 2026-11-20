use program_tests::{market::*, *};
#[test]
fn launch_mints_full_supply_and_splits_fee_for_both_quote_programs() {
    for program in [classic(), token_2022_id()] {
        let MarketEnv {
            env, keys, wallet, ..
        } = MarketEnv::new(program);
        let mint = env.account(&keys.base).unwrap();
        assert_eq!(mint.owner, token_2022_id());
        assert_eq!(
            &mint.data[..4],
            &[0; 4],
            "irreversible mint authority revocation"
        );
        assert_eq!(&mint.data[46..50], &[0; 4], "no freeze authority");
        assert_eq!(
            u64::from_le_bytes(mint.data[36..44].try_into().unwrap()),
            100_000_000
        );
        assert!(mint.data.windows(4).any(|w| w == b"Demo"));
        assert_eq!(env.balance(keys.base_vault), 100_000_000);
        assert_eq!(env.balance(keys.quote_vault), 1000);
        assert_eq!(
            env.balance(wallet_ata(wallet.pubkey(), keys.quote, program)),
            49_999_000
        );
        let market: Market = env.decode("Market", &keys.market);
        assert_eq!(
            (market.maker_base, market.maker_quote, market.platform_fees),
            (100_000_000, 600, 400)
        );
        assert_eq!(market.stage, Stage::Line);
    }
}
#[test]
fn suspended_cut_coin_holder_can_withdraw_despite_unsolicited_vault_surplus() {
    let MarketEnv {
        mut env,
        keys,
        wallet,
        badge,
    } = MarketEnv::new(classic());
    env.send(
        &[env.deposit_ix(&keys, &badge, wallet.pubkey(), 10_000, false)],
        &[&wallet],
    )
    .unwrap();
    env.mint_to(keys.quote, keys.quote_vault, keys.quote_program, 7);
    env.suspend(&badge.participant_id).unwrap();
    let admin = env.admin.insecure_clone();
    env.send(&[env.stage_ix(&keys, 3)], &[&admin]).unwrap();
    env.send(&[env.withdraw_ix(&keys, &badge, 10_000, false)], &[&wallet])
        .unwrap();
    assert_eq!(env.balance(keys.quote_vault), 1007);
    let p: Position = env.decode(
        "Position",
        &position(keys.market, participant_pda(&badge.participant_id)),
    );
    assert_eq!(p.quote, 0);
    expect_err(
        env.send(
            &[env.deposit_ix(&keys, &badge, wallet.pubkey(), 1, false)],
            &[&wallet],
        ),
        "ParticipantNotActive",
    );
    expect_err(
        env.send(&[env.stage_ix(&keys, 1)], &[&admin]),
        "InvalidStageTransition",
    );
}
