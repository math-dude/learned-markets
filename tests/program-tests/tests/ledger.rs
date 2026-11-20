//! Replay Eren's core episode against the compiled Solana program, one transaction per batch.
use borsh::{BorshDeserialize, BorshSerialize};
use program_tests::{
    market::{budget, pays, pda, ro, rw, sig},
    *,
};
use serde_json::{json, Value};
use solana_account::Account;
use solana_instruction::Instruction;
use solana_message::{v0, AddressLookupTableAccount, VersionedMessage};
use solana_transaction::versioned::VersionedTransaction;

#[derive(BorshDeserialize, Debug)]
struct LedgerMarket {
    _version: u8,
    _bump: u8,
    _id: Address,
    _deployer: Address,
    reserve_cash: u64,
    reserve_tokens: u64,
    last_batch_id: Option<u64>,
    last_price: u64,
    live: bool,
}
#[derive(BorshDeserialize)]
struct LedgerBalance {
    _version: u8,
    _bump: u8,
    _participant: Address,
    cash: u64,
}
#[derive(BorshDeserialize)]
struct LedgerPosition {
    _version: u8,
    _bump: u8,
    _market: Address,
    _participant: Address,
    tokens: u64,
}
#[derive(BorshDeserialize)]
struct LedgerPlatform {
    _version: u8,
    _bump: u8,
    cash: u64,
}
#[derive(BorshSerialize, Clone)]
struct Fill {
    intent: Address,
    contents: Vec<u8>,
    quantity: u64,
    fee_rate_ppm: u32,
}
struct Player {
    wallet: Kp,
    badge: Badge,
    p: Address,
    balance: Address,
    position: Address,
    nonce: u64,
}
struct Game {
    env: Env,
    market: Address,
    platform: Address,
    players: Vec<Player>,
}
impl Game {
    fn new(initial_cash: &[u64], deployer: usize, launch_fee: u64) -> Self {
        let mut env = Env::new();
        let admin = env.admin.insecure_clone();
        let market_id = Address::new_from_array([0xd1; 32]);
        let market = pda(&[b"ledger-market", market_id.as_ref()]);
        let platform = pda(&[b"ledger-platform"]);
        let mut players = vec![];
        for (i, &cash) in initial_cash.iter().enumerate() {
            let seed = u8::try_from(i + 40).unwrap();
            let wallet = env.new_wallet(seed);
            let badge = env.issue_badge([seed; 32], &wallet.pubkey(), 1);
            env.register(&wallet, &badge).unwrap();
            let p = participant_pda(&badge.participant_id);
            let balance = pda(&[b"ledger-balance", p.as_ref()]);
            let credit = env.market_ix(
                "credit_ledger_balance",
                vec![
                    pays(admin.pubkey()),
                    ro(config_pda()),
                    ro(p),
                    rw(balance),
                    ro(system_id()),
                ],
                &cash,
            );
            let result = env.send(&[credit], &[&admin]);
            // The production build disables minting demo cash. Only that build uses
            // genesis allocations in LiteSVM. The demo profile must exercise the real credit.
            if result.as_ref().err().and_then(|err| err.custom_code())
                == Some(err_code("LedgerCreditDisabled"))
            {
                assert!(
                    !cfg!(feature = "demo-credit"),
                    "build the program with learned-markets/demo-credit"
                );
                let bump =
                    Address::find_program_address(&[b"ledger-balance", p.as_ref()], &lm_id()).1;
                let mut data = env.idl.accounts["LedgerBalance"].clone();
                data.extend(borsh::to_vec(&(1u8, bump, p, cash)).unwrap());
                env.svm
                    .set_account(
                        balance,
                        Account {
                            lamports: env.svm.minimum_balance_for_rent_exemption(data.len()),
                            owner: lm_id(),
                            data,
                            executable: false,
                            rent_epoch: 0,
                        },
                    )
                    .unwrap();
            } else {
                result.unwrap();
            }
            let position = pda(&[b"ledger-position", market.as_ref(), p.as_ref()]);
            players.push(Player {
                wallet,
                badge,
                p,
                balance,
                position,
                nonce: 0,
            });
        }
        let sa = env.settlement_authority.insecure_clone();
        let d = &players[deployer];
        let open = env.market_ix(
            "open_ledger_market",
            vec![
                pays(d.wallet.pubkey()),
                sig(sa.pubkey()),
                ro(config_pda()),
                ro(d.p),
                rw(d.balance),
                rw(market),
                rw(platform),
                ro(system_id()),
            ],
            &(market_id, launch_fee),
        );
        env.send(&[open], &[&d.wallet, &sa]).unwrap();
        for player in &players {
            let ix = env.market_ix(
                "initialize_ledger_position",
                vec![
                    pays(env.payer.pubkey()),
                    ro(market),
                    ro(player.p),
                    rw(player.position),
                    ro(system_id()),
                ],
                &(),
            );
            env.send(&[ix], &[]).unwrap();
        }
        Self {
            env,
            market,
            platform,
            players,
        }
    }
    fn order(
        &mut self,
        i: usize,
        side: u8,
        points: &[(u64, u64)],
        qty: u64,
        rate: u32,
    ) -> (usize, u64, Fill) {
        let player = &mut self.players[i];
        let nonce = player.nonce;
        let contents = trade_contents(side, points);
        let submit = self.env.ix_submit_raw(
            &player.wallet.pubkey(),
            &player.badge.participant_id,
            &player.badge,
            nonce,
            KIND_TRADE,
            &self.market,
            payload_hash(NETWORK, KIND_TRADE, &self.market, &contents),
            self.env.now() + 60,
        );
        self.env.send(&[submit], &[&player.wallet]).unwrap();
        player.nonce += 1;
        (
            i,
            nonce,
            Fill {
                intent: intent_pda(&player.p, nonce),
                contents,
                quantity: qty,
                fee_rate_ppm: rate,
            },
        )
    }
    fn ix(
        &self,
        id: u64,
        price: u64,
        buy: u64,
        sell: u64,
        orders: &[(usize, u64, Fill)],
    ) -> Instruction {
        let e = &self.env;
        let mut accounts = vec![
            sig(e.settlement_authority.pubkey()),
            ro(config_pda()),
            rw(self.market),
            rw(self.platform),
            ro(e.credential),
            ro(e.schema),
            ro(e.schema_mint),
        ];
        let mut fills = vec![];
        for (i, nonce, fill) in orders {
            let p = &self.players[*i];
            accounts.extend(e.settle_intent_metas(
                &p.badge.participant_id,
                *nonce,
                &p.wallet.pubkey(),
                &p.badge,
            ));
            accounts.extend([rw(p.balance), rw(p.position)]);
            fills.push(fill);
        }
        e.market_ix(
            "settle_ledger_batch",
            accounts,
            &(self.market, id, price, buy, sell, fills),
        )
    }
    fn settle(&mut self, ix: Instruction) -> TxResult {
        // As in a live relayer, use address compression and an explicit compute budget.
        let mut addresses: Vec<_> = ix
            .accounts
            .iter()
            .filter(|m| !m.is_signer)
            .map(|m| m.pubkey)
            .collect();
        addresses.sort();
        addresses.dedup();
        let key = Address::new_unique();
        let mut data = vec![0u8; 56];
        data[..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
        for address in &addresses {
            data.extend(address.as_ref());
        }
        self.env
            .svm
            .set_account(
                key,
                Account {
                    owner: pk("AddressLookupTab1e1111111111111111111111111"),
                    lamports: self.env.svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        self.env.svm.expire_blockhash();
        let msg = v0::Message::try_compile(
            &self.env.payer.pubkey(),
            &[budget(), ix],
            &[AddressLookupTableAccount { key, addresses }],
            self.env.svm.latest_blockhash(),
        )
        .unwrap();
        let msg = VersionedMessage::V0(msg);
        let tx =
            VersionedTransaction::try_new(msg, &[&self.env.payer, &self.env.settlement_authority])
                .unwrap();
        assert!(
            tx.message.serialize().len() + 1 + 64 * tx.signatures.len() <= 1232,
            "batch exceeds Solana packet size even with a lookup table"
        );
        self.env.svm.send_transaction(tx).map_err(|f| TxFailure {
            err: f.err,
            logs: f.meta.logs,
        })
    }
    fn state(&self) -> Value {
        let market: LedgerMarket = self.env.decode("LedgerMarket", &self.market);
        let platform: LedgerPlatform = self.env.decode("LedgerPlatform", &self.platform);
        let cash: Vec<u64> = self
            .players
            .iter()
            .map(|p| {
                self.env
                    .decode::<LedgerBalance>("LedgerBalance", &p.balance)
                    .cash
            })
            .collect();
        let tokens: Vec<u64> = self
            .players
            .iter()
            .map(|p| {
                self.env
                    .decode::<LedgerPosition>("LedgerPosition", &p.position)
                    .tokens
            })
            .collect();
        json!({"cash":cash,"tokens":tokens,"reserve_cash":market.reserve_cash,"reserve_tokens":market.reserve_tokens,"platform_cash":platform.cash})
    }
}
fn n(v: &Value) -> u64 {
    v.as_u64().unwrap()
}
#[test]
fn replay_core_episode() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/settlement-episode.json");
    let episode: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let initial: Vec<_> = episode["initial_cash"]
        .as_array()
        .unwrap()
        .iter()
        .map(n)
        .collect();
    let mut game = Game::new(
        &initial,
        n(&episode["launch"]["deployer"]) as usize,
        n(&episode["launch"]["launch_fee"]),
    );
    for batch in episode["batches"].as_array().unwrap() {
        let mut orders = vec![];
        for f in batch["fills"].as_array().unwrap() {
            let points: Vec<_> = f["curve"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| (n(&v[0]), n(&v[1])))
                .collect();
            orders.push(game.order(
                n(&f["person"]) as usize,
                match f["side"].as_str().unwrap() {
                    "buy" => 0,
                    "sell" => 1,
                    s => panic!("bad side {s}"),
                },
                &points,
                n(&f["quantity"]),
                u32::try_from(n(&f["fee_rate_ppm"])).unwrap(),
            ));
        }
        let id = n(&batch["batch_id"]);
        let price = n(&batch["clearing_price"]);
        let ix = game.ix(
            id,
            price,
            n(&batch["quoter_buy"]),
            n(&batch["quoter_sell"]),
            &orders,
        );
        game.settle(ix).unwrap();
        let state = game.state();
        for key in [
            "cash",
            "tokens",
            "reserve_cash",
            "reserve_tokens",
            "platform_cash",
        ] {
            assert_eq!(state[key], batch["after"][key], "batch {id}: {key}");
        }
        let m: LedgerMarket = game.env.decode("LedgerMarket", &game.market);
        assert_eq!(m.last_batch_id, Some(id));
        assert_eq!(m.last_price, price);
        assert!(m.live);
        for (person, nonce, _) in orders {
            assert_eq!(
                game.env
                    .intent(&game.players[person].badge.participant_id, nonce)
                    .state,
                IntentState::Consumed
            );
        }
    }
}
#[test]
fn atomic_rejections_preserve_balances_and_admitted_intents() {
    let mut game = Game::new(&[1000, 1000], 0, 101);
    let a = game.order(0, 0, &[(1_000_000, 4), (2_000_000, 1)], 2, 0);
    let b = game.order(1, 0, &[(1_000_000, 1000)], 2, 0);
    let before = game.state();
    // Between points a buy uses the next askable quantity (1), with no interpolation.
    expect_err(
        game.settle(game.ix(1, 1_100_000, 0, 2, std::slice::from_ref(&a))),
        "InvalidLedgerFill",
    );
    expect_err(
        game.settle(game.ix(1, 1_000_000, 0, 1, std::slice::from_ref(&a))),
        "LedgerTokenMismatch",
    );
    expect_err(
        game.settle(game.ix(1, 1_000_000, 0, 4, &[a.clone(), a.clone()])),
        "IntentNotOpen",
    );
    let a_second = game.order(0, 0, &[(1_000_000, 4)], 1, 0);
    expect_err(
        game.settle(game.ix(1, 1_000_000, 0, 3, &[a.clone(), a_second])),
        "DuplicateParticipantInChunk",
    );
    let mut zero = b.clone();
    zero.2.quantity = 0;
    expect_err(
        game.settle(game.ix(1, 1_000_000, 0, 0, &[zero])),
        "InvalidLedgerFill",
    );
    let mut bad = b.clone();
    bad.2.quantity = 1000;
    expect_err(
        game.settle(game.ix(1, 1_000_000, 0, 1002, &[a.clone(), bad])),
        "InsufficientBalance",
    );
    assert_eq!(before, game.state());
    assert_eq!(
        game.env
            .intent(&game.players[0].badge.participant_id, 0)
            .state,
        IntentState::Open
    );
    game.settle(game.ix(1, 1_000_000, 0, 4, &[a, b])).unwrap();
    assert_eq!(
        game.state(),
        json!({"cash":[896,997],"tokens":[2,2],"reserve_cash":55,"reserve_tokens":999999996,"platform_cash":52})
    );
    expect_err(
        game.settle(game.ix(1, 1_000_000, 0, 0, &[])),
        "WrongBatchId",
    );
    let mut s = game.order(0, 1, &[(500_000, 1), (1_500_000, 2)], 2, 250000);
    expect_err(
        game.settle(game.ix(2, 1_000_000, 2, 0, std::slice::from_ref(&s))),
        "InvalidLedgerFill",
    );
    s.2.quantity = 1;
    s.2.fee_rate_ppm = 250001;
    expect_err(
        game.settle(game.ix(2, 1_000_000, 1, 0, std::slice::from_ref(&s))),
        "LedgerFeeRateOutOfRange",
    );
    s.2.fee_rate_ppm = 9999;
    expect_err(
        game.settle(game.ix(2, 1_000_000, 1, 0, std::slice::from_ref(&s))),
        "LedgerFeeRateOutOfRange",
    );
    s.2.fee_rate_ppm = 250000;
    expect_err(
        game.settle(game.ix(2, 1_000_000_000, 1, 0, std::slice::from_ref(&s))),
        "MakerBudgetExceeded",
    );
    game.settle(game.ix(2, 1_000_000, 1, 0, &[s])).unwrap();
    let sa = game.env.settlement_authority.insecure_clone();
    let close = game.env.market_ix(
        "close_ledger_market",
        vec![sig(sa.pubkey()), ro(config_pda()), rw(game.market), rw(game.platform)],
        &(),
    );
    game.env.send(&[close], &[&sa]).unwrap();
    expect_err(
        game.settle(game.ix(3, 1_000_000, 0, 0, &[])),
        "MarketClosed",
    );
}

impl Game {
    /// Open another ledger market deployed by player `i`.
    fn open_extra(&mut self, i: usize, id: u8, launch_fee: u64) -> Address {
        let market_id = Address::new_from_array([id; 32]);
        let market = pda(&[b"ledger-market", market_id.as_ref()]);
        let sa = self.env.settlement_authority.insecure_clone();
        let d = &self.players[i];
        let wallet = d.wallet.insecure_clone();
        let open = self.env.market_ix(
            "open_ledger_market",
            vec![
                pays(wallet.pubkey()),
                sig(sa.pubkey()),
                ro(config_pda()),
                ro(d.p),
                rw(d.balance),
                rw(market),
                rw(self.platform),
                ro(system_id()),
            ],
            &(market_id, launch_fee),
        );
        self.env.send(&[open], &[&wallet, &sa]).unwrap();
        market
    }
    fn close_ix(&self, market: Address, pairs: Vec<solana_instruction::AccountMeta>) -> Instruction {
        let mut accounts = vec![
            sig(self.env.settlement_authority.pubkey()),
            ro(config_pda()),
            rw(market),
            rw(self.platform),
        ];
        accounts.extend(pairs);
        self.env.market_ix("close_ledger_market", accounts, &())
    }
    fn close(&mut self, market: Address, pairs: Vec<solana_instruction::AccountMeta>) -> TxResult {
        let ix = self.close_ix(market, pairs);
        let sa = self.env.settlement_authority.insecure_clone();
        self.env.send(&[ix], &[&sa])
    }
    fn market_state(&self, market: &Address) -> LedgerMarket {
        self.env.decode("LedgerMarket", market)
    }
    /// Every unit of ledger cash: player balances, the platform and the given reserves.
    fn total_cash(&self, markets: &[Address]) -> u64 {
        let s = self.state();
        let cash: u64 = s["cash"].as_array().unwrap().iter().map(n).sum();
        let reserves: u64 = markets.iter().map(|m| self.market_state(m).reserve_cash).sum();
        cash + n(&s["platform_cash"]) + reserves
    }
}

#[test]
fn close_redistributes_reserve_to_survivors_deployers_and_platform() {
    let mut game = Game::new(&[1000, 1000, 1000], 0, 101);
    let m1 = game.open_extra(1, 0xa1, 200);
    let m2 = game.open_extra(2, 0xa2, 300);
    let m3 = game.open_extra(1, 0xa3, 100);
    let all = [game.market, m1, m2, m3];
    let before = game.total_cash(&all);
    let s0 = game.state();
    assert_eq!(game.market_state(&game.market).reserve_cash, 50);
    let (b1, b2) = (game.players[1].balance, game.players[2].balance);
    // Player 1 deploys two survivors, so their balance appears in two pairs.
    game.close(
        game.market,
        vec![rw(m1), rw(b1), rw(m2), rw(b2), rw(m3), rw(b1)],
    )
    .unwrap();
    // 50 total: 60% / 3 = 10 per survivor, 20% / 3 = 3 per deployer, platform 50 - 39 = 11.
    let closed = game.market_state(&game.market);
    assert!(!closed.live);
    assert_eq!(closed.reserve_cash, 0);
    assert_eq!(game.market_state(&m1).reserve_cash, 110);
    assert_eq!(game.market_state(&m2).reserve_cash, 160);
    assert_eq!(game.market_state(&m3).reserve_cash, 60);
    let s1 = game.state();
    assert_eq!(n(&s1["cash"][1]), n(&s0["cash"][1]) + 6);
    assert_eq!(n(&s1["cash"][2]), n(&s0["cash"][2]) + 3);
    assert_eq!(n(&s1["cash"][0]), n(&s0["cash"][0]));
    assert_eq!(n(&s1["platform_cash"]), n(&s0["platform_cash"]) + 11);
    assert_eq!(game.total_cash(&all), before);
    expect_err(game.close(game.market, vec![]), "MarketClosed");
}

#[test]
fn close_without_survivors_pays_the_platform() {
    let mut game = Game::new(&[1000], 0, 101);
    let before = game.total_cash(&[game.market]);
    let s0 = game.state();
    game.close(game.market, vec![]).unwrap();
    assert_eq!(game.market_state(&game.market).reserve_cash, 0);
    assert_eq!(n(&game.state()["platform_cash"]), n(&s0["platform_cash"]) + 50);
    assert_eq!(game.total_cash(&[game.market]), before);
}

#[test]
fn close_rejects_invalid_survivors() {
    let mut game = Game::new(&[1000, 1000], 0, 101);
    let m1 = game.open_extra(1, 0xa1, 200);
    let dead = game.open_extra(1, 0xa2, 200);
    game.close(dead, vec![]).unwrap();
    let (b0, b1) = (game.players[0].balance, game.players[1].balance);
    let all = [game.market, m1, dead];
    let before = (game.state(), game.total_cash(&all));
    let cases = vec![
        vec![rw(m1)],                             // odd count
        vec![rw(game.market), rw(b0)],            // survivor is the closing market
        vec![rw(m1), rw(b1), rw(m1), rw(b1)],     // duplicate survivor
        vec![rw(m1), rw(b0)],                     // balance is not the survivor's deployer
        vec![rw(dead), rw(b1)],                   // survivor is not live
        vec![rw(system_id()), rw(b1)],            // not a program account
        vec![ro(m1), rw(b1)],                     // survivor not writable
        vec![rw(m1), rw(game.platform)],          // not a ledger balance
    ];
    for (i, pairs) in cases.into_iter().enumerate() {
        let res = game.close(game.market, pairs);
        match res {
            Ok(_) => panic!("case {i} succeeded"),
            Err(f) => {
                let code = f.custom_code();
                assert!(
                    code == Some(err_code("InvalidSurvivor")) || code == Some(3002) || code == Some(3007),
                    "case {i}: {:?} {:?}",
                    code,
                    f.logs
                );
            }
        }
    }
    assert_eq!((game.state(), game.total_cash(&all)), before);
    assert!(game.market_state(&game.market).live);
    game.close(game.market, vec![rw(m1), rw(b1)]).unwrap();
}

/// Captured from the compiled program for independent client decoders/builders.
#[test]
fn parity_wire_fixtures() {
    use base64::Engine;
    let mut game = Game::new(&[1000, 1000], 0, 101);
    let order = game.order(1, 0, &[(1_000_000, 4), (2_000_000, 1)], 2, 0);
    let ix = game.ix(1, 1_000_000, 0, 2, std::slice::from_ref(&order));
    game.settle(ix.clone()).unwrap();
    let (i, _, fill) = order;
    let player = &game.players[i];
    let accounts = [
        ("market", game.market),
        ("platform", game.platform),
        ("balance", player.balance),
        ("position", player.position),
    ]
    .into_iter()
    .map(|(name, address)| {
        let account = game.env.account(&address).unwrap();
        (
            name.to_string(),
            json!({"address":address.to_string(),"owner":account.owner.to_string(),
            "dataBase64":base64::engine::general_purpose::STANDARD.encode(account.data)}),
        )
    })
    .collect::<serde_json::Map<_, _>>();
    let metas: Vec<_> = ix
        .accounts
        .iter()
        .map(|m| json!([m.pubkey.to_string(), m.is_writable, m.is_signer]))
        .collect();
    let value = json!({"marketId":Address::new_from_array([0xd1;32]).to_string(),"participant":player.p.to_string(),
        "accounts":accounts,"settleLedgerBatch":{"dataHex":hex::encode(ix.data),"accounts":metas,
        "request":{"market":game.market.to_string(),"batchId":1,"clearingPrice":1000000,"quoterBuy":0,"quoterSell":2,
        "intents":[{"intent":fill.intent.to_string(),"contentsHex":hex::encode(fill.contents),"quantity":2,"feeRatePpm":0}]}},
        "after":game.state()});
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/ledger-wire.json");
    let text = serde_json::to_string_pretty(&value).unwrap() + "\n";
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(path, text).unwrap();
    } else {
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }
}

#[test]
fn synthetic_credit_requires_admin_and_a_demo_network() {
    let mut env = Env::bare();
    let deployer = env.deployer.insecure_clone();
    env.send(
        &[env.ix_initialize_config(&deployer.pubkey(), "mainnet-beta")],
        &[&deployer],
    )
    .unwrap();
    let (mut ix, balance, wallet) = credit_test_instruction(&mut env);
    let admin = env.admin.insecure_clone();
    expect_err(env.send(&[ix.clone()], &[&admin]), "LedgerCreditDisabled");
    ix.accounts[0] = pays(wallet.pubkey());
    expect_err(env.send(&[ix], &[&wallet]), "NotAdmin");
    assert!(env.account(&balance).is_none());
}

fn credit_test_instruction(env: &mut Env) -> (Instruction, Address, Kp) {
    let wallet = env.new_wallet(50);
    let badge = env.issue_badge([50; 32], &wallet.pubkey(), 1);
    env.register(&wallet, &badge).unwrap();
    let participant = participant_pda(&badge.participant_id);
    let balance = pda(&[b"ledger-balance", participant.as_ref()]);
    let admin = env.admin.insecure_clone();
    let ix = env.market_ix(
        "credit_ledger_balance",
        vec![
            pays(admin.pubkey()),
            ro(config_pda()),
            ro(participant),
            rw(balance),
            ro(system_id()),
        ],
        &1u64,
    );
    (ix, balance, wallet)
}

#[cfg(not(feature = "demo-credit"))]
#[test]
fn default_build_disables_localnet_credit() {
    let mut env = Env::new();
    assert_eq!(env.config().network, "localnet");
    let (ix, balance, _) = credit_test_instruction(&mut env);
    let admin = env.admin.insecure_clone();
    expect_err(env.send(&[ix], &[&admin]), "LedgerCreditDisabled");
    assert!(env.account(&balance).is_none());
}
