//! Independent v2 instruction encoders and token-program builders for LiteSVM.
use super::*;
pub fn ro(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}
pub fn rw(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, false)
}
pub fn sig(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, true)
}
pub fn pays(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, true)
}
pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    find(seeds, &lm_id())
}
pub fn board() -> Pubkey {
    pda(&[b"board"])
}
pub fn position(market: Pubkey, participant: Pubkey) -> Pubkey {
    pda(&[b"position", market.as_ref(), participant.as_ref()])
}
pub fn classic() -> Pubkey {
    pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}
pub fn wallet_ata(wallet: Pubkey, mint: Pubkey, program: Pubkey) -> Pubkey {
    find(
        &[wallet.as_ref(), program.as_ref(), mint.as_ref()],
        &ata_program_id(),
    )
}
pub fn budget() -> Instruction {
    Instruction {
        program_id: pk("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data: borsh::to_vec(&(2u8, 1_400_000u32)).unwrap(),
    }
}
pub struct MarketKeys {
    pub market: Pubkey,
    pub base: Pubkey,
    pub quote: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub quote_program: Pubkey,
}
impl MarketKeys {
    pub fn new(participant: Pubkey, idx: u64, quote: Pubkey, quote_program: Pubkey) -> Self {
        let base = pda(&[b"mint", participant.as_ref(), &idx.to_le_bytes()]);
        let market = pda(&[b"market", base.as_ref()]);
        Self {
            market,
            base,
            quote,
            quote_program,
            base_vault: pda(&[b"vault", market.as_ref(), base.as_ref()]),
            quote_vault: pda(&[b"vault", market.as_ref(), quote.as_ref()]),
        }
    }
    pub fn token_accounts(&self, base: bool, wallet: Pubkey) -> Vec<AccountMeta> {
        let (mint, vault, program) = if base {
            (self.base, self.base_vault, token_2022_id())
        } else {
            (self.quote, self.quote_vault, self.quote_program)
        };
        vec![
            rw(mint),
            rw(vault),
            rw(wallet_ata(wallet, mint, program)),
            ro(program),
        ]
    }
}
impl Env {
    pub fn market_ix(
        &self,
        name: &str,
        accounts: Vec<AccountMeta>,
        args: &impl BorshSerialize,
    ) -> Instruction {
        Instruction {
            program_id: lm_id(),
            accounts,
            data: self.ix_data(name, args),
        }
    }
    pub fn mint_quote(&mut self, mint: &Keypair, program: Pubkey) {
        let rent = self.svm.minimum_balance_for_rent_exemption(82);
        let create = Instruction {
            program_id: system_id(),
            accounts: vec![pays(self.payer.pubkey()), pays(mint.pubkey())],
            data: borsh::to_vec(&(0u32, rent, 82u64, program)).unwrap(),
        };
        let mut data = vec![20, 6];
        data.extend(self.payer.pubkey().as_ref());
        data.push(0);
        let init = Instruction {
            program_id: program,
            accounts: vec![rw(mint.pubkey())],
            data,
        };
        self.send(&[create, init], &[mint]).unwrap();
    }
    pub fn create_ata(&mut self, wallet: Pubkey, mint: Pubkey, program: Pubkey) -> Pubkey {
        let ata = wallet_ata(wallet, mint, program);
        let ix = Instruction {
            program_id: ata_program_id(),
            accounts: vec![
                pays(self.payer.pubkey()),
                rw(ata),
                ro(wallet),
                ro(mint),
                ro(system_id()),
                ro(program),
            ],
            data: vec![1],
        };
        self.send(&[ix], &[]).unwrap();
        ata
    }
    pub fn mint_to(&mut self, mint: Pubkey, ata: Pubkey, program: Pubkey, amount: u64) {
        let ix = Instruction {
            program_id: program,
            accounts: vec![rw(mint), rw(ata), sig(self.payer.pubkey())],
            data: borsh::to_vec(&(7u8, amount)).unwrap(),
        };
        self.send(&[ix], &[]).unwrap();
    }
    pub fn balance(&self, token: Pubkey) -> u64 {
        u64::from_le_bytes(
            self.account(&token).unwrap().data[64..72]
                .try_into()
                .unwrap(),
        )
    }
    pub fn board_ix(&self, quote: Pubkey) -> Instruction {
        let authority = self.deployer.pubkey();
        let admin = self.admin.pubkey();
        self.market_ix(
            "initialize_board",
            vec![
                pays(authority),
                ro(lm_id()),
                ro(self.program_data(&lm_id())),
                rw(board()),
                ro(system_id()),
            ],
            &(admin, admin, admin, quote, 1000u64, 6000u16, true),
        )
    }
    pub fn launch_ix(&self, m: &MarketKeys, badge: &Badge) -> Instruction {
        let w = badge.wallet;
        let p = participant_pda(&badge.participant_id);
        let mut a = vec![
            pays(w),
            rw(board()),
            ro(config_pda()),
            ro(p),
            ro(wallet_binding_pda(&w)),
        ];
        a.extend(self.badge_metas(badge));
        a.extend([
            rw(m.base),
            ro(m.quote),
            rw(m.market),
            rw(m.base_vault),
            rw(m.quote_vault),
            rw(wallet_ata(w, m.quote, m.quote_program)),
            ro(token_2022_id()),
            ro(m.quote_program),
            ro(system_id()),
        ]);
        let bounds = (1000u16, 3600u32, 10u16, 200u16, 100u16, 10_000_000u64);
        let limits = (10_000_000u64, 10_000_000u64, 4000u16, 5000u16);
        self.market_ix(
            "create_market",
            a,
            &(
                "Demo",
                "DMO",
                "https://example.com/coin",
                100_000_000u64,
                1_000_000u64,
                3u32,
                bounds,
                limits,
                500u16,
                3000u16,
                self.settlement_authority.pubkey(),
            ),
        )
    }
    pub fn deposit_ix(
        &self,
        m: &MarketKeys,
        badge: &Badge,
        source: Pubkey,
        amount: u64,
        base: bool,
    ) -> Instruction {
        let p = participant_pda(&badge.participant_id);
        let mut a = vec![
            pays(badge.wallet),
            ro(config_pda()),
            ro(p),
            ro(wallet_binding_pda(&badge.wallet)),
        ];
        a.extend(self.badge_metas(badge));
        a.extend([
            sig(source),
            ro(wallet_binding_pda(&source)),
            rw(m.market),
            rw(position(m.market, p)),
        ]);
        a.extend(m.token_accounts(base, source));
        a.push(ro(system_id()));
        self.market_ix(
            if base {
                "deposit_base"
            } else {
                "deposit_quote"
            },
            a,
            &amount,
        )
    }
    pub fn withdraw_ix(
        &self,
        m: &MarketKeys,
        badge: &Badge,
        amount: u64,
        base: bool,
    ) -> Instruction {
        let p = participant_pda(&badge.participant_id);
        let mut a = vec![
            sig(badge.wallet),
            ro(config_pda()),
            ro(p),
            rw(m.market),
            rw(position(m.market, p)),
        ];
        a.extend(m.token_accounts(base, badge.wallet));
        self.market_ix(
            if base {
                "withdraw_base"
            } else {
                "withdraw_quote"
            },
            a,
            &amount,
        )
    }
    pub fn stage_ix(&self, m: &MarketKeys, stage: u8) -> Instruction {
        self.market_ix(
            "set_stage",
            vec![sig(self.admin.pubkey()), ro(board()), rw(m.market)],
            &stage,
        )
    }
}
pub struct MarketEnv {
    pub env: Env,
    pub keys: MarketKeys,
    pub wallet: Keypair,
    pub badge: Badge,
}
impl MarketEnv {
    pub fn new(program: Pubkey) -> Self {
        let mut env = Env::new();
        let wallet = env.new_wallet(20);
        let mint = keypair(31);
        let badge = env.issue_badge([32; 32], &wallet.pubkey(), 1);
        env.register(&wallet, &badge).unwrap();
        env.mint_quote(&mint, program);
        let ata = env.create_ata(wallet.pubkey(), mint.pubkey(), program);
        env.mint_to(mint.pubkey(), ata, program, 50_000_000);
        let d = env.deployer.insecure_clone();
        env.send(&[env.board_ix(mint.pubkey())], &[&d]).unwrap();
        let keys = MarketKeys::new(
            participant_pda(&badge.participant_id),
            0,
            mint.pubkey(),
            program,
        );
        env.send(&[budget(), env.launch_ix(&keys, &badge)], &[&wallet])
            .unwrap();
        Self {
            env,
            keys,
            wallet,
            badge,
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub enum Stage {
    Line,
    Rookie,
    Regular,
    Cut,
    Dead,
}
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct TermsBounds {
    pub max_total_fee_bps: u16,
    pub max_hold_secs: u32,
    pub min_cap_bps: u16,
    pub max_cap_bps: u16,
    pub rookie_max_cap_bps: u16,
    pub max_per_person_batch_max: u64,
}
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct MakerLimits {
    pub max_net_sell_per_batch: u64,
    pub max_net_buy_per_batch: u64,
    pub max_price_move_bps: u16,
    pub rookie_max_price_move_bps: u16,
}
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Market {
    pub version: u8,
    pub bump: u8,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub deployer: Pubkey,
    pub quoter: Pubkey,
    pub created_at: i64,
    pub created_slot: u64,
    pub total_supply: u64,
    pub stage: Stage,
    pub stage_changed_at: i64,
    pub batch_id: u64,
    pub last_settled_batch: Option<u64>,
    pub last_price: u64,
    pub batch_len_slots: u32,
    pub open_price: u64,
    pub settling: bool,
    pub maker_quote: i64,
    pub maker_fee_income: u64,
    pub maker_trading_quote: i64,
    pub maker_base: u64,
    pub risk_allowance: u64,
    pub risk_drawn_peak: u64,
    pub platform_fees: u64,
    pub deployer_fees: u64,
    pub deployer_fee_bps: u16,
    pub platform_fee_share_bps: u16,
    pub total_user_quote: u64,
    pub total_user_base: u64,
    pub bounds: TermsBounds,
    pub limits: MakerLimits,
    pub final_reserve_quote: u64,
    pub swept: bool,
}
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Position {
    pub version: u8,
    pub bump: u8,
    pub market: Pubkey,
    pub participant: Pubkey,
    pub base: u64,
    pub external_base: u64,
    pub quote: u64,
    pub last_buy_ts: i64,
    pub batch_seen: u64,
    pub batch_bought: u64,
    pub batch_sold: u64,
    pub total_bought: u64,
    pub total_sold: u64,
    pub fees_paid: u64,
}
