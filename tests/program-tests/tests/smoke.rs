use program_tests::*;

#[test]
fn happy_path_smoke() {
    let mut env = Env::new();
    let alice = env.new_wallet(10);
    let pid = [11u8; 32];
    let badge = env.issue_badge(pid, &alice.pubkey(), 1);
    let r = env.register(&alice, &badge);
    if let Err(e) = &r { panic!("{:?}\n{}", e.err, e.logs.join("\n")); }
    let p = env.participant(&pid);
    assert_eq!(p.current_wallet, alice.pubkey());
    let market = Kp::new().pubkey();
    let r = env.submit_trade(&alice, &badge, 0, &market);
    if let Err(e) = &r { panic!("{:?}\n{}", e.err, e.logs.join("\n")); }
    let r = env.settle_one(&pid, 0, &alice.pubkey(), &badge, &market, sample_trade());
    expect_err(r, "SettlementNotImplemented");
}
