//! pump.fun + PumpSwap event extractor for Jetstreamer (vaultic-win fork).
//!
//! Installed into `jetstreamer-plugin/src/plugins/pump_events.rs` by `install.sh`.
//!
//! Tables written (all `ReplacingMergeTree`, so replayed batches deduplicate):
//! - `pump_creates`   pump CreateEvent (name, symbol, uri for vamp detection)
//! - `pump_trades`    pump bonding-curve TradeEvent
//! - `pump_completes` pump CompleteEvent (kind 0) and CompletePumpAmmMigrationEvent (kind 1)
//! - `amm_trades`     PumpSwap BuyEvent / SellEvent
//! - `amm_pools`      PumpSwap CreatePoolEvent
//! - `token_deltas`   token balance changes of pump mints in transactions that do NOT touch
//!                    pump or PumpSwap (wallet transfers, other DEXes). Trade legs are already
//!                    in the trade tables.
//! - `pump_txs`       one row per transaction touching pump/PumpSwap, failed ones included:
//!                    signer, fee, compute units, top-level programs, instruction names/args.
//!
//! Events are emitted by both programs with Anchor `emit_cpi!`: a self-invoked inner
//! instruction whose data is EVENT_IX_TAG (8 bytes) + event discriminator (8 bytes) + borsh.
//! Event layouts grew over time, so every field after the stable prefix is decoded as optional.
//! Pubkeys and signatures are stored as base58 strings so the exports are directly usable.

use ahash::RandomState;
use std::sync::Arc;

use clickhouse::{Client, Row};
use dashmap::{DashMap, DashSet};
use futures_util::FutureExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use solana_message::VersionedMessage;

use crate::{Plugin, PluginFuture};
use jetstreamer_firehose::firehose::{BlockData, TransactionData};

// 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
const PUMP_PROGRAM: [u8; 32] = [
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151,
    245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
];
// pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
const PUMP_AMM_PROGRAM: [u8; 32] = [
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86,
    213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
];

/// Anchor `EVENT_IX_TAG_LE` (sha256("anchor:event")[..8]).
const EVENT_IX_TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

// Discriminators from pump-public-docs idl/pump.json and idl/pump_amm.json.
const D_CREATE: [u8; 8] = [27, 114, 169, 77, 222, 235, 99, 118];
const D_TRADE: [u8; 8] = [189, 219, 127, 211, 78, 230, 97, 238];
const D_COMPLETE: [u8; 8] = [95, 114, 97, 156, 212, 46, 152, 8];
const D_MIGRATION: [u8; 8] = [189, 233, 93, 185, 92, 148, 234, 148];
const D_AMM_BUY: [u8; 8] = [103, 244, 82, 31, 44, 245, 119, 119];
const D_AMM_SELL: [u8; 8] = [62, 47, 55, 10, 165, 3, 220, 42];
const D_AMM_CREATE_POOL: [u8; 8] = [177, 49, 12, 210, 160, 118, 167, 116];

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct PumpCreate {
    slot: u64,
    tx_index: u32,
    ev_idx: u16,
    signature: String,
    timestamp: i64,
    mint: String,
    name: String,
    symbol: String,
    uri: String,
    bonding_curve: String,
    user: String,
    creator: Option<String>,
    virtual_token_reserves: Option<u64>,
    virtual_sol_reserves: Option<u64>,
    real_token_reserves: Option<u64>,
    token_total_supply: Option<u64>,
    token_program: Option<String>,
    is_mayhem_mode: Option<bool>,
    is_cashback_enabled: Option<bool>,
    quote_mint: Option<String>,
    virtual_quote_reserves: Option<u64>,
    creator_fee_bps: Option<u64>,
    is_holder_reward: Option<bool>,
    depth: Option<u8>,
    outer_ix: u16,
    inner_ix: u16,
}

#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct PumpTrade {
    slot: u64,
    tx_index: u32,
    ev_idx: u16,
    signature: String,
    timestamp: i64,
    mint: String,
    is_buy: bool,
    user: String,
    sol_amount: u64,
    token_amount: u64,
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    real_sol_reserves: Option<u64>,
    real_token_reserves: Option<u64>,
    fee_basis_points: Option<u64>,
    fee: Option<u64>,
    creator: Option<String>,
    creator_fee_basis_points: Option<u64>,
    creator_fee: Option<u64>,
    ix_name: Option<String>,
    mayhem_mode: Option<bool>,
    quote_mint: Option<String>,
    quote_amount: Option<u64>,
    virtual_quote_reserves: Option<u64>,
    real_quote_reserves: Option<u64>,
    track_volume: Option<bool>,
    cashback_fee_basis_points: Option<u64>,
    cashback: Option<u64>,
    buyback_fee_basis_points: Option<u64>,
    buyback_fee: Option<u64>,
    n_shareholders: Option<u32>,
    holder_rewards_bps: Option<u64>,
    holder_rewards: Option<u64>,
    creator_fee_unclaimed: Option<u64>,
    /// Hex of trailing bytes not yet described by the public IDL (newer fields).
    tail: String,
    outer_ix: u16,
    inner_ix: u16,
    /// Decimals of the curve's quote mint from the transaction's token balances (NULL for
    /// native SOL curves, which use 9).
    quote_decimals: Option<u8>,
}

#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct PumpComplete {
    slot: u64,
    tx_index: u32,
    ev_idx: u16,
    signature: String,
    /// 0 = CompleteEvent (curve finished), 1 = CompletePumpAmmMigrationEvent (pool created).
    kind: u8,
    timestamp: i64,
    user: String,
    mint: String,
    bonding_curve: String,
    mint_amount: Option<u64>,
    sol_amount: Option<u64>,
    pool_migration_fee: Option<u64>,
    pool: Option<String>,
    quote_mint: Option<String>,
    outer_ix: u16,
    inner_ix: u16,
}

#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct AmmTrade {
    slot: u64,
    tx_index: u32,
    ev_idx: u16,
    signature: String,
    timestamp: i64,
    is_buy: bool,
    pool: String,
    user: String,
    /// From the PumpSwap instruction's accounts (pool, user, config, base_mint, quote_mint, ...);
    /// falls back to the transaction's token balances.
    base_mint: Option<String>,
    quote_mint: Option<String>,
    base_amount: u64,
    /// Buy: quote_amount_in. Sell: quote_amount_out (before fees).
    quote_amount: u64,
    /// Buy: user_quote_amount_in (with all fees). Sell: user_quote_amount_out (after fees).
    user_quote_amount: u64,
    pool_base_token_reserves: u64,
    pool_quote_token_reserves: u64,
    lp_fee: u64,
    protocol_fee: u64,
    coin_creator: Option<String>,
    coin_creator_fee: Option<u64>,
    /// Buy: max_quote_amount_in. Sell: min_quote_amount_out (the trader's slippage limit).
    quote_limit: u64,
    /// The user's token balances before the trade.
    user_base_token_reserves: u64,
    user_quote_token_reserves: u64,
    lp_fee_basis_points: u64,
    protocol_fee_basis_points: u64,
    coin_creator_fee_basis_points: Option<u64>,
    /// Buy: quote_amount_in_with_lp_fee. Sell: quote_amount_out_without_lp_fee.
    quote_amount_lp_adjusted: u64,
    track_volume: Option<bool>,
    min_base_amount_out: Option<u64>,
    ix_name: Option<String>,
    cashback_fee_basis_points: Option<u64>,
    cashback: Option<u64>,
    buyback_fee_basis_points: Option<u64>,
    buyback_fee: Option<u64>,
    /// v2 pools: signed offset added to the quote vault to get the curve's effective reserve.
    virtual_quote_reserves: Option<i128>,
    can_boost: Option<bool>,
    base_supply: Option<u64>,
    holder_rewards_bps: Option<u64>,
    holder_rewards: Option<u64>,
    creator_fee_unclaimed: Option<u64>,
    tail: String,
    outer_ix: u16,
    inner_ix: u16,
    /// Mint decimals from the transaction's token balances (NULL if neither side's account
    /// appears there, e.g. a temporary WSOL account; WSOL is 9).
    base_decimals: Option<u8>,
    quote_decimals: Option<u8>,
}

#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct AmmPool {
    slot: u64,
    tx_index: u32,
    ev_idx: u16,
    signature: String,
    timestamp: i64,
    pool: String,
    creator: String,
    base_mint: String,
    quote_mint: String,
    base_amount_in: u64,
    quote_amount_in: u64,
    lp_mint: Option<String>,
    coin_creator: Option<String>,
    base_mint_decimals: u8,
    quote_mint_decimals: u8,
    pool_base_amount: u64,
    pool_quote_amount: u64,
    lp_token_amount_out: u64,
    is_mayhem_mode: Option<bool>,
    creator_fee_bps: Option<u64>,
    can_edit_creator_fee: Option<bool>,
    is_holder_reward: Option<bool>,
    outer_ix: u16,
    inner_ix: u16,
}

#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct TokenDelta {
    slot: u64,
    tx_index: u32,
    signature: String,
    mint: String,
    token_account: String,
    owner: String,
    pre_amount: u64,
    post_amount: u64,
    decimals: u8,
    /// Fee payer (first signer).
    signer: String,
    /// Distinct top-level programs, in order (classifies transfers vs. other DEXes/routers).
    programs: Vec<String>,
}

/// One row per successful or failed transaction that touches pump or PumpSwap.
#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct PumpTx {
    slot: u64,
    tx_index: u32,
    signature: String,
    signer: String,
    success: bool,
    err: Option<String>,
    /// Total fee in lamports (base + priority).
    fee: u64,
    n_signatures: u8,
    compute_units: Option<u64>,
    programs: Vec<String>,
    /// Top-level pump/PumpSwap instructions as "pump:<ix>" / "amm:<ix>" (IDL names); empty when
    /// the program was reached through a router's CPI.
    pump_ixs: Vec<String>,
    /// First two u64 args of the first top-level pump/PumpSwap instruction (amount, limit):
    /// keeps the intent of failed trades.
    ix_arg0: Option<u64>,
    ix_arg1: Option<u64>,
    n_events: u16,
}

#[derive(Default)]
struct SlotRows {
    creates: Vec<PumpCreate>,
    trades: Vec<PumpTrade>,
    completes: Vec<PumpComplete>,
    amm_trades: Vec<AmmTrade>,
    amm_pools: Vec<AmmPool>,
    deltas: Vec<TokenDelta>,
    txs: Vec<PumpTx>,
}

impl SlotRows {
    fn append(&mut self, other: SlotRows) {
        self.creates.extend(other.creates);
        self.trades.extend(other.trades);
        self.completes.extend(other.completes);
        self.amm_trades.extend(other.amm_trades);
        self.amm_pools.extend(other.amm_pools);
        self.deltas.extend(other.deltas);
        self.txs.extend(other.txs);
    }
    fn is_empty(&self) -> bool {
        self.creates.is_empty()
            && self.trades.is_empty()
            && self.completes.is_empty()
            && self.amm_trades.is_empty()
            && self.amm_pools.is_empty()
            && self.deltas.is_empty()
            && self.txs.is_empty()
    }
}

static PENDING_BY_SLOT: Lazy<DashMap<u64, SlotRows, RandomState>> =
    Lazy::new(|| DashMap::with_hasher(RandomState::new()));

/// Mints seen in CreateEvents during this run (catches pump mints without the `pump` suffix).
static KNOWN_MINTS: Lazy<DashSet<String, RandomState>> =
    Lazy::new(|| DashSet::with_hasher(RandomState::new()));

// ---------------------------------------------------------------------------------------------
// Borsh reader that tolerates truncated (older) layouts
// ---------------------------------------------------------------------------------------------

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let s = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn bool(&mut self) -> Option<bool> {
        self.u8().map(|b| b != 0)
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_le_bytes(b.try_into().unwrap()))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
    }
    fn u64(&mut self) -> Option<u64> {
        self.take(8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
    }
    fn i64(&mut self) -> Option<i64> {
        self.take(8).map(|b| i64::from_le_bytes(b.try_into().unwrap()))
    }
    fn pubkey(&mut self) -> Option<String> {
        self.take(32).map(bs58)
    }
    fn string(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        if len > 4096 {
            return None;
        }
        self.take(len).map(|b| String::from_utf8_lossy(b).into_owned())
    }
    fn i128(&mut self) -> Option<i128> {
        self.take(16).map(|b| i128::from_le_bytes(b.try_into().unwrap()))
    }
    /// Skips a borsh Vec of fixed-size elements, returning its length.
    fn skip_vec(&mut self, elem_size: usize) -> Option<u32> {
        let len = self.u32()?;
        self.take((len as usize).checked_mul(elem_size)?).map(|_| len)
    }
    /// Hex of the bytes not consumed yet (fields newer than the IDL we decode against).
    fn tail_hex(&self) -> String {
        let rest = self.buf.get(self.pos..).unwrap_or_default();
        let mut s = String::with_capacity(rest.len() * 2);
        for b in rest {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }
}

/// Minimal base58 encoder (Bitcoin alphabet), used for pubkeys and signatures.
fn bs58(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 138 / 100 + 1);
    for &byte in &bytes[zeros..] {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        out.push('1');
    }
    for d in digits.iter().rev() {
        out.push(ALPHABET[*d as usize] as char);
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Event decoders. Each returns None if the stable prefix is missing.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Ctx<'a> {
    slot: u64,
    tx_index: u32,
    signature: &'a str,
    /// Top-level instruction the event was emitted under, and its position among that
    /// instruction's inner instructions (Solana's analogue of a log index).
    outer_ix: u16,
    inner_ix: u16,
}

fn decode_create(c: &Ctx, ev_idx: u16, r: &mut Reader) -> Option<PumpCreate> {
    let name = r.string()?;
    let symbol = r.string()?;
    let uri = r.string()?;
    let mint = r.pubkey()?;
    let bonding_curve = r.pubkey()?;
    let user = r.pubkey()?;
    let creator = r.pubkey();
    let timestamp = r.i64().unwrap_or(0);
    let virtual_token_reserves = r.u64();
    let virtual_sol_reserves = r.u64();
    let real_token_reserves = r.u64();
    let token_total_supply = r.u64();
    let token_program = r.pubkey();
    let is_mayhem_mode = r.bool();
    let is_cashback_enabled = r.bool();
    let quote_mint = r.pubkey();
    let virtual_quote_reserves = r.u64();
    let creator_fee_bps = r.u64();
    let is_holder_reward = r.bool();
    let depth = r.u8();
    Some(PumpCreate {
        slot: c.slot,
        tx_index: c.tx_index,
        ev_idx,
        signature: c.signature.to_owned(),
        timestamp,
        mint,
        name,
        symbol,
        uri,
        bonding_curve,
        user,
        creator,
        virtual_token_reserves,
        virtual_sol_reserves,
        real_token_reserves,
        token_total_supply,
        token_program,
        is_mayhem_mode,
        is_cashback_enabled,
        quote_mint,
        virtual_quote_reserves,
        creator_fee_bps,
        is_holder_reward,
        depth,
        outer_ix: c.outer_ix,
        inner_ix: c.inner_ix,
    })
}

fn decode_trade(c: &Ctx, ev_idx: u16, r: &mut Reader) -> Option<PumpTrade> {
    let mint = r.pubkey()?;
    let sol_amount = r.u64()?;
    let token_amount = r.u64()?;
    let is_buy = r.bool()?;
    let user = r.pubkey()?;
    let timestamp = r.i64()?;
    let virtual_sol_reserves = r.u64()?;
    let virtual_token_reserves = r.u64()?;
    let real_sol_reserves = r.u64();
    let real_token_reserves = r.u64();
    let _fee_recipient = r.pubkey();
    let fee_basis_points = r.u64();
    let fee = r.u64();
    let creator = r.pubkey();
    let creator_fee_basis_points = r.u64();
    let creator_fee = r.u64();
    let track_volume = r.bool();
    let _total_unclaimed_tokens = r.u64();
    let _total_claimed_tokens = r.u64();
    let _current_sol_volume = r.u64();
    let _last_update_timestamp = r.i64();
    let ix_name = r.string();
    let mayhem_mode = r.bool();
    let cashback_fee_basis_points = r.u64();
    let cashback = r.u64();
    let buyback_fee_basis_points = r.u64();
    let buyback_fee = r.u64();
    // Vec<Shareholder { address: Pubkey, share_bps: u16 }>
    let n_shareholders = r.skip_vec(34);
    let (quote_mint, quote_amount, virtual_quote_reserves, real_quote_reserves) =
        if n_shareholders.is_some() {
            (r.pubkey(), r.u64(), r.u64(), r.u64())
        } else {
            (None, None, None, None)
        };
    let holder_rewards_bps = r.u64();
    let holder_rewards = r.u64();
    let creator_fee_unclaimed = r.u64();
    Some(PumpTrade {
        slot: c.slot,
        tx_index: c.tx_index,
        ev_idx,
        signature: c.signature.to_owned(),
        timestamp,
        mint,
        is_buy,
        user,
        sol_amount,
        token_amount,
        virtual_sol_reserves,
        virtual_token_reserves,
        real_sol_reserves,
        real_token_reserves,
        fee_basis_points,
        fee,
        creator,
        creator_fee_basis_points,
        creator_fee,
        ix_name,
        mayhem_mode,
        quote_mint,
        quote_amount,
        virtual_quote_reserves,
        real_quote_reserves,
        track_volume,
        cashback_fee_basis_points,
        cashback,
        buyback_fee_basis_points,
        buyback_fee,
        n_shareholders,
        holder_rewards_bps,
        holder_rewards,
        creator_fee_unclaimed,
        tail: r.tail_hex(),
        outer_ix: c.outer_ix,
        inner_ix: c.inner_ix,
        quote_decimals: None,
    })
}

fn decode_complete(c: &Ctx, ev_idx: u16, r: &mut Reader) -> Option<PumpComplete> {
    let user = r.pubkey()?;
    let mint = r.pubkey()?;
    let bonding_curve = r.pubkey()?;
    let timestamp = r.i64().unwrap_or(0);
    let quote_mint = r.pubkey();
    Some(PumpComplete {
        slot: c.slot,
        tx_index: c.tx_index,
        ev_idx,
        signature: c.signature.to_owned(),
        kind: 0,
        timestamp,
        user,
        mint,
        bonding_curve,
        mint_amount: None,
        sol_amount: None,
        pool_migration_fee: None,
        pool: None,
        quote_mint,
        outer_ix: c.outer_ix,
        inner_ix: c.inner_ix,
    })
}

fn decode_migration(c: &Ctx, ev_idx: u16, r: &mut Reader) -> Option<PumpComplete> {
    let user = r.pubkey()?;
    let mint = r.pubkey()?;
    let mint_amount = r.u64();
    let sol_amount = r.u64();
    let pool_migration_fee = r.u64();
    let bonding_curve = r.pubkey()?;
    let timestamp = r.i64().unwrap_or(0);
    let pool = r.pubkey();
    let quote_mint = r.pubkey();
    Some(PumpComplete {
        slot: c.slot,
        tx_index: c.tx_index,
        ev_idx,
        signature: c.signature.to_owned(),
        kind: 1,
        timestamp,
        user,
        mint,
        bonding_curve,
        mint_amount,
        sol_amount,
        pool_migration_fee,
        pool,
        quote_mint,
        outer_ix: c.outer_ix,
        inner_ix: c.inner_ix,
    })
}

/// BuyEvent and SellEvent share field positions up to `coin_creator_fee`. After that, BuyEvent
/// has volume-tracking fields, `min_base_amount_out` and `ix_name`; both then continue with
/// cashback, buyback, `virtual_quote_reserves` and holder rewards.
fn decode_amm_trade(
    c: &Ctx,
    ev_idx: u16,
    is_buy: bool,
    r: &mut Reader,
    pool_mints: &dyn Fn(&str, &str, &str) -> (Option<String>, Option<String>),
) -> Option<AmmTrade> {
    let timestamp = r.i64()?;
    let base_amount = r.u64()?; // base_amount_out | base_amount_in
    let quote_limit = r.u64()?; // max_quote_amount_in | min_quote_amount_out
    let user_base_token_reserves = r.u64()?;
    let user_quote_token_reserves = r.u64()?;
    let pool_base_token_reserves = r.u64()?;
    let pool_quote_token_reserves = r.u64()?;
    let quote_amount = r.u64()?; // quote_amount_in | quote_amount_out
    let lp_fee_basis_points = r.u64()?;
    let lp_fee = r.u64()?;
    let protocol_fee_basis_points = r.u64()?;
    let protocol_fee = r.u64()?;
    let quote_amount_lp_adjusted = r.u64()?;
    let user_quote_amount = r.u64()?; // user_quote_amount_in | user_quote_amount_out
    let pool = r.pubkey()?;
    let user = r.pubkey()?;
    let user_base_token_account = r.pubkey()?;
    let user_quote_token_account = r.pubkey()?;
    let _protocol_fee_recipient = r.pubkey();
    let _protocol_fee_recipient_token_account = r.pubkey();
    let coin_creator = r.pubkey();
    let coin_creator_fee_basis_points = r.u64();
    let coin_creator_fee = r.u64();
    let (track_volume, min_base_amount_out, ix_name) = if is_buy {
        let tv = r.bool();
        let _total_unclaimed_tokens = r.u64();
        let _total_claimed_tokens = r.u64();
        let _current_sol_volume = r.u64();
        let _last_update_timestamp = r.i64();
        (tv, r.u64(), r.string())
    } else {
        (None, None, None)
    };
    let cashback_fee_basis_points = r.u64();
    let cashback = r.u64();
    let buyback_fee_basis_points = r.u64();
    let buyback_fee = r.u64();
    let virtual_quote_reserves = r.i128();
    let can_boost = r.bool();
    let base_supply = r.u64();
    let holder_rewards_bps = r.u64();
    let holder_rewards = r.u64();
    let creator_fee_unclaimed = r.u64();
    let (base_mint, quote_mint) =
        pool_mints(&pool, &user_base_token_account, &user_quote_token_account);
    Some(AmmTrade {
        slot: c.slot,
        tx_index: c.tx_index,
        ev_idx,
        signature: c.signature.to_owned(),
        timestamp,
        is_buy,
        pool,
        user,
        base_mint,
        quote_mint,
        base_amount,
        quote_amount,
        user_quote_amount,
        pool_base_token_reserves,
        pool_quote_token_reserves,
        lp_fee,
        protocol_fee,
        coin_creator,
        coin_creator_fee,
        quote_limit,
        user_base_token_reserves,
        user_quote_token_reserves,
        lp_fee_basis_points,
        protocol_fee_basis_points,
        coin_creator_fee_basis_points,
        quote_amount_lp_adjusted,
        track_volume,
        min_base_amount_out,
        ix_name,
        cashback_fee_basis_points,
        cashback,
        buyback_fee_basis_points,
        buyback_fee,
        virtual_quote_reserves,
        can_boost,
        base_supply,
        holder_rewards_bps,
        holder_rewards,
        creator_fee_unclaimed,
        tail: r.tail_hex(),
        outer_ix: c.outer_ix,
        inner_ix: c.inner_ix,
        base_decimals: None,
        quote_decimals: None,
    })
}

fn decode_create_pool(c: &Ctx, ev_idx: u16, r: &mut Reader) -> Option<AmmPool> {
    let timestamp = r.i64()?;
    let _index = r.u16()?;
    let creator = r.pubkey()?;
    let base_mint = r.pubkey()?;
    let quote_mint = r.pubkey()?;
    let base_mint_decimals = r.u8()?;
    let quote_mint_decimals = r.u8()?;
    let base_amount_in = r.u64()?;
    let quote_amount_in = r.u64()?;
    let pool_base_amount = r.u64()?;
    let pool_quote_amount = r.u64()?;
    let _minimum_liquidity = r.u64()?;
    let _initial_liquidity = r.u64()?;
    let lp_token_amount_out = r.u64()?;
    let _pool_bump = r.u8()?;
    let pool = r.pubkey()?;
    let lp_mint = r.pubkey();
    let _user_base_token_account = r.pubkey();
    let _user_quote_token_account = r.pubkey();
    let coin_creator = r.pubkey();
    let is_mayhem_mode = r.bool();
    let creator_fee_bps = r.u64();
    let can_edit_creator_fee = r.bool();
    let is_holder_reward = r.bool();
    Some(AmmPool {
        slot: c.slot,
        tx_index: c.tx_index,
        ev_idx,
        signature: c.signature.to_owned(),
        timestamp,
        pool,
        creator,
        base_mint,
        quote_mint,
        base_amount_in,
        quote_amount_in,
        lp_mint,
        coin_creator,
        base_mint_decimals,
        quote_mint_decimals,
        pool_base_amount,
        pool_quote_amount,
        lp_token_amount_out,
        is_mayhem_mode,
        creator_fee_bps,
        can_edit_creator_fee,
        is_holder_reward,
        outer_ix: c.outer_ix,
        inner_ix: c.inner_ix,
    })
}

// ---------------------------------------------------------------------------------------------
// Transaction handling
// ---------------------------------------------------------------------------------------------

/// (program is PumpSwap, instruction discriminator, IDL name), generated from pump-public-docs IDLs.
const IX_NAMES: &[(bool, [u8; 8], &str)] = &[
    (false, [2, 14, 61, 138, 170, 142, 14, 95], "add_quote_control_mint"),
    (false, [111, 121, 21, 56, 40, 24, 94, 209], "add_quote_mint"),
    (false, [125, 126, 214, 134, 77, 229, 188, 89], "admin_cto"),
    (false, [8, 217, 96, 231, 144, 104, 192, 5], "admin_set_idl_authority"),
    (false, [209, 11, 115, 87, 213, 23, 124, 204], "admin_update_token_incentives"),
    (false, [102, 6, 61, 18, 1, 218, 235, 234], "buy"),
    (false, [194, 171, 28, 70, 104, 77, 91, 47], "buy_exact_quote_in_v2"),
    (false, [225, 247, 80, 30, 213, 179, 132, 136], "buy_exact_quote_in_v3"),
    (false, [56, 252, 116, 8, 158, 223, 205, 95], "buy_exact_sol_in"),
    (false, [184, 23, 238, 97, 103, 197, 211, 61], "buy_v2"),
    (false, [7, 5, 29, 196, 245, 23, 101, 80], "buy_v3"),
    (false, [37, 58, 35, 126, 190, 53, 228, 197], "claim_cashback"),
    (false, [122, 243, 204, 65, 94, 116, 29, 55], "claim_cashback_v2"),
    (false, [16, 4, 71, 28, 204, 1, 40, 27], "claim_token_incentives"),
    (false, [249, 69, 164, 218, 150, 103, 84, 138], "close_user_volume_accumulator"),
    (false, [20, 22, 86, 123, 198, 28, 219, 132], "collect_creator_fee"),
    (false, [207, 17, 138, 242, 4, 34, 19, 56], "collect_creator_fee_v2"),
    (false, [24, 30, 200, 40, 5, 28, 7, 119], "create"),
    (false, [214, 144, 76, 236, 95, 139, 49, 180], "create_v2"),
    (false, [165, 114, 103, 0, 121, 206, 247, 81], "distribute_creator_fees"),
    (false, [255, 203, 19, 79, 244, 68, 8, 159], "distribute_creator_fees_v2"),
    (false, [98, 54, 145, 97, 2, 70, 173, 43], "distribute_fee_to_holders"),
    (false, [234, 102, 194, 203, 150, 72, 62, 229], "extend_account"),
    (false, [117, 225, 127, 202, 134, 95, 68, 35], "get_minimum_distributable_fee"),
    (false, [94, 6, 202, 115, 255, 96, 232, 183], "init_user_volume_accumulator"),
    (false, [175, 175, 109, 31, 13, 152, 155, 237], "initialize"),
    (false, [239, 73, 245, 173, 209, 177, 84, 66], "initialize_quote_control"),
    (false, [155, 234, 231, 146, 236, 158, 162, 30], "migrate"),
    (false, [87, 124, 52, 191, 52, 38, 214, 232], "migrate_bonding_curve_creator"),
    (false, [187, 203, 18, 31, 206, 237, 254, 41], "migrate_v2"),
    (false, [225, 154, 117, 22, 215, 86, 246, 103], "multi_hop_curve_swap"),
    (false, [223, 7, 253, 26, 81, 165, 218, 166], "remove_quote_control_mint"),
    (false, [177, 65, 223, 38, 88, 209, 158, 155], "remove_quote_mint"),
    (false, [51, 230, 133, 164, 1, 127, 131, 173], "sell"),
    (false, [93, 246, 130, 60, 231, 233, 64, 178], "sell_v2"),
    (false, [28, 146, 222, 119, 38, 196, 105, 213], "sell_v3"),
    (false, [254, 148, 255, 112, 207, 142, 170, 165], "set_creator"),
    (false, [32, 154, 152, 219, 142, 108, 218, 165], "set_max_curve_depth"),
    (false, [61, 169, 188, 191, 153, 149, 42, 97], "set_mayhem_virtual_params"),
    (false, [138, 96, 174, 217, 48, 85, 197, 246], "set_metaplex_creator"),
    (false, [27, 234, 178, 52, 147, 2, 187, 141], "set_params"),
    (false, [62, 79, 161, 211, 165, 170, 214, 210], "set_quote_control_admin"),
    (false, [116, 220, 107, 83, 191, 44, 32, 73], "set_quote_control_mint_reserves"),
    (false, [161, 195, 222, 165, 225, 101, 192, 62], "set_quote_control_reserves_admin"),
    (false, [111, 172, 162, 232, 114, 89, 213, 142], "set_reserved_fee_recipients"),
    (false, [101, 135, 191, 104, 9, 88, 20, 96], "set_virtual_quote_reserves"),
    (false, [32, 246, 191, 52, 8, 201, 73, 186], "sweep_creator_fee"),
    (false, [8, 48, 190, 7, 182, 68, 183, 229], "sweep_protocol_fee"),
    (false, [86, 31, 192, 87, 163, 87, 79, 238], "sync_user_volume_accumulator"),
    (false, [115, 103, 224, 255, 189, 89, 86, 195], "toggle_cashback_enabled"),
    (false, [28, 255, 230, 240, 172, 107, 203, 171], "toggle_create_v2"),
    (false, [1, 9, 111, 208, 100, 31, 255, 163], "toggle_mayhem_mode"),
    (false, [251, 224, 171, 146, 160, 26, 113, 233], "update_buyback_config"),
    (false, [61, 175, 160, 249, 66, 66, 136, 175], "update_creator_fee_config"),
    (false, [227, 181, 74, 196, 208, 21, 97, 213], "update_global_authority"),
    (false, [225, 252, 66, 4, 199, 35, 236, 16], "update_holder_reward_config"),
    (true, [45, 61, 165, 151, 104, 0, 49, 189], "admin_cto_pool"),
    (true, [209, 11, 115, 87, 213, 23, 124, 204], "admin_update_token_incentives"),
    (true, [105, 68, 6, 175, 0, 7, 35, 162], "boost_buy_and_burn"),
    (true, [102, 6, 61, 18, 1, 218, 235, 234], "buy"),
    (true, [198, 46, 21, 82, 180, 217, 232, 112], "buy_exact_quote_in"),
    (true, [194, 171, 28, 70, 104, 77, 91, 47], "buy_exact_quote_in_v2"),
    (true, [184, 23, 238, 97, 103, 197, 211, 61], "buy_v2"),
    (true, [37, 58, 35, 126, 190, 53, 228, 197], "claim_cashback"),
    (true, [16, 4, 71, 28, 204, 1, 40, 27], "claim_token_incentives"),
    (true, [249, 69, 164, 218, 150, 103, 84, 138], "close_user_volume_accumulator"),
    (true, [160, 57, 89, 42, 181, 139, 43, 66], "collect_coin_creator_fee"),
    (true, [201, 207, 243, 114, 75, 111, 47, 189], "create_config"),
    (true, [233, 146, 209, 142, 207, 104, 64, 188], "create_pool"),
    (true, [242, 35, 198, 137, 82, 225, 242, 182], "deposit"),
    (true, [185, 173, 187, 90, 216, 15, 238, 233], "disable"),
    (true, [234, 102, 194, 203, 150, 72, 62, 229], "extend_account"),
    (true, [140, 233, 33, 94, 132, 90, 194, 143], "init_boost"),
    (true, [94, 6, 202, 115, 255, 96, 232, 183], "init_user_volume_accumulator"),
    (true, [208, 8, 159, 4, 74, 175, 16, 58], "migrate_pool_coin_creator"),
    (true, [43, 100, 73, 19, 233, 246, 111, 148], "multi_hop_swap"),
    (true, [51, 230, 133, 164, 1, 127, 131, 173], "sell"),
    (true, [93, 246, 130, 60, 231, 233, 64, 178], "sell_v2"),
    (true, [227, 149, 76, 42, 130, 39, 234, 205], "set_boost_authority"),
    (true, [210, 149, 128, 45, 188, 58, 78, 175], "set_coin_creator"),
    (true, [111, 172, 162, 232, 114, 89, 213, 142], "set_reserved_fee_recipients"),
    (true, [32, 246, 191, 52, 8, 201, 73, 186], "sweep_creator_fee"),
    (true, [8, 48, 190, 7, 182, 68, 183, 229], "sweep_protocol_fee"),
    (true, [86, 31, 192, 87, 163, 87, 79, 238], "sync_user_volume_accumulator"),
    (true, [117, 161, 160, 74, 223, 137, 118, 99], "toggle_boost"),
    (true, [115, 103, 224, 255, 189, 89, 86, 195], "toggle_cashback_enabled"),
    (true, [1, 9, 111, 208, 100, 31, 255, 163], "toggle_mayhem_mode"),
    (true, [139, 52, 134, 85, 228, 229, 108, 241], "transfer_creator_fees_to_pump"),
    (true, [1, 33, 78, 185, 33, 67, 44, 92], "transfer_creator_fees_to_pump_v2"),
    (true, [161, 176, 40, 213, 60, 184, 179, 228], "update_admin"),
    (true, [251, 224, 171, 146, 160, 26, 113, 233], "update_buyback_config"),
    (true, [61, 175, 160, 249, 66, 66, 136, 175], "update_creator_fee_config"),
    (true, [104, 184, 103, 242, 88, 151, 107, 20], "update_fee_config"),
    (true, [183, 18, 70, 156, 148, 109, 161, 34], "withdraw"),
];

fn ix_name(is_amm: bool, data: &[u8]) -> Option<&'static str> {
    let disc: [u8; 8] = data.get(..8)?.try_into().ok()?;
    IX_NAMES
        .iter()
        .find(|(amm, d, _)| *amm == is_amm && *d == disc)
        .map(|(_, _, n)| *n)
}

fn extract(tx: &TransactionData) -> SlotRows {
    let mut rows = SlotRows::default();
    let meta = &tx.transaction_status_meta;
    let message = &tx.transaction.message;

    let static_keys = match message {
        VersionedMessage::Legacy(m) => &m.account_keys,
        VersionedMessage::V0(m) => &m.account_keys,
        VersionedMessage::V1(m) => &m.account_keys,
    };
    // Full account list: static keys, then loaded writable, then loaded readonly.
    let key_at = |i: usize| -> Option<&[u8]> {
        let n_static = static_keys.len();
        let n_w = meta.loaded_addresses.writable.len();
        if i < n_static {
            Some(static_keys[i].as_ref())
        } else if i < n_static + n_w {
            Some(meta.loaded_addresses.writable[i - n_static].as_ref())
        } else {
            meta.loaded_addresses
                .readonly
                .get(i - n_static - n_w)
                .map(|k| k.as_ref())
        }
    };
    let total_keys =
        static_keys.len() + meta.loaded_addresses.writable.len() + meta.loaded_addresses.readonly.len();
    let touches_pump = (0..total_keys).any(|i| {
        key_at(i).is_some_and(|k| k == PUMP_PROGRAM.as_slice() || k == PUMP_AMM_PROGRAM.as_slice())
    });
    let is_pump_mint = |m: &str| m.ends_with("pump") || KNOWN_MINTS.contains(m);
    if !touches_pump {
        // Cheap exit for the vast majority of transactions.
        let has_pump_balance = [&meta.pre_token_balances, &meta.post_token_balances]
            .into_iter()
            .flatten()
            .flatten()
            .any(|b| is_pump_mint(&b.mint));
        if !has_pump_balance || meta.status.is_err() {
            return rows;
        }
    }

    let signature = bs58(tx.signature.as_ref());
    let signer = static_keys.first().map(|k| bs58(k.as_ref())).unwrap_or_default();
    let top_level = message.instructions();
    let mut programs: Vec<String> = Vec::new();
    for ix in top_level {
        if let Some(k) = key_at(ix.program_id_index as usize) {
            let p = bs58(k);
            if !programs.contains(&p) {
                programs.push(p);
            }
        }
    }
    let ctx = Ctx {
        slot: tx.slot,
        tx_index: tx.transaction_slot_index.min(u32::MAX as usize) as u32,
        signature: &signature,
        outer_ix: 0,
        inner_ix: 0,
    };

    if touches_pump {
        // Transaction-level row (also for failed transactions: unfilled demand).
        let mut pump_ixs: Vec<String> = Vec::new();
        let mut ix_args: (Option<u64>, Option<u64>) = (None, None);
        for ix in top_level {
            let Some(p) = key_at(ix.program_id_index as usize) else { continue };
            let is_amm = p == PUMP_AMM_PROGRAM.as_slice();
            if !(is_amm || p == PUMP_PROGRAM.as_slice()) {
                continue;
            }
            let name = ix_name(is_amm, &ix.data).unwrap_or("unknown");
            if pump_ixs.is_empty() {
                let mut r = Reader::new(ix.data.get(8..).unwrap_or_default());
                ix_args = (r.u64(), r.u64());
            }
            pump_ixs.push(format!("{}:{}", if is_amm { "amm" } else { "pump" }, name));
        }
        let mut tx_row = PumpTx {
            slot: ctx.slot,
            tx_index: ctx.tx_index,
            signature: signature.clone(),
            signer: signer.clone(),
            success: meta.status.is_ok(),
            err: meta.status.as_ref().err().map(|e| format!("{e:?}")),
            fee: meta.fee,
            n_signatures: tx.transaction.signatures.len().min(255) as u8,
            compute_units: meta.compute_units_consumed,
            programs: programs.clone(),
            pump_ixs,
            ix_arg0: ix_args.0,
            ix_arg1: ix_args.1,
            n_events: 0,
        };
        if meta.status.is_err() {
            // Failed transactions emit no events, but are kept: unfilled demand, slippage
            // failures and bot retries are all signal.
            rows.txs.push(tx_row);
            return rows;
        }

        // PumpSwap trade instructions name the pool and both mints in fixed account slots
        // (pool=0, base_mint=3, quote_mint=4), for top-level and CPI calls alike.
        let mut pool_accounts: Vec<(String, String, String)> = Vec::new();
        let inner_ixs = meta.inner_instructions.iter().flatten().flat_map(|g| g.instructions.iter().map(|i| &i.instruction));
        for ix in top_level.iter().chain(inner_ixs) {
            if key_at(ix.program_id_index as usize) != Some(PUMP_AMM_PROGRAM.as_slice()) {
                continue;
            }
            let is_trade = ix_name(true, &ix.data).is_some_and(|n| n.starts_with("buy") || n.starts_with("sell"));
            if !is_trade || ix.accounts.len() < 5 {
                continue;
            }
            let acct = |j: usize| key_at(ix.accounts[j] as usize).map(bs58);
            if let (Some(pool), Some(base), Some(quote)) = (acct(0), acct(3), acct(4)) {
                pool_accounts.push((pool, base, quote));
            }
        }
        // Fallback: token account -> mint from the transaction's token balances.
        let mut account_mints: Vec<(String, String)> = Vec::new();
        let mut mint_decimals: Vec<(String, u8)> = Vec::new();
        for list in [&meta.pre_token_balances, &meta.post_token_balances]
            .into_iter()
            .flatten()
        {
            for b in list {
                if let Some(k) = key_at(b.account_index as usize) {
                    account_mints.push((bs58(k), b.mint.clone()));
                }
                if !mint_decimals.iter().any(|(m, _)| *m == b.mint) {
                    mint_decimals.push((b.mint.clone(), b.ui_token_amount.decimals));
                }
            }
        }
        let decimals_of = |m: &Option<String>| -> Option<u8> {
            let m = m.as_deref()?;
            mint_decimals.iter().find(|(x, _)| x == m).map(|(_, d)| *d)
        };
        let lookup = |acct: &str| -> Option<String> {
            account_mints
                .iter()
                .find(|(a, _)| a == acct)
                .map(|(_, m)| m.clone())
        };
        let pool_mints = |pool: &str, user_base: &str, user_quote: &str| {
            if let Some((_, b, q)) = pool_accounts.iter().find(|(p, _, _)| p == pool) {
                (Some(b.clone()), Some(q.clone()))
            } else {
                (lookup(user_base), lookup(user_quote))
            }
        };

        let mut ev_idx: u16 = 0;
        if let Some(inner) = &meta.inner_instructions {
            for group in inner {
                for (j, ix) in group.instructions.iter().enumerate() {
                    let ci = &ix.instruction;
                    let data = &ci.data;
                    if data.len() < 16 || data[..8] != EVENT_IX_TAG {
                        continue;
                    }
                    let Some(program) = key_at(ci.program_id_index as usize) else {
                        continue;
                    };
                    let ectx = Ctx {
                        outer_ix: group.index as u16,
                        inner_ix: j.min(u16::MAX as usize) as u16,
                        ..ctx
                    };
                    let disc: [u8; 8] = data[8..16].try_into().unwrap();
                    let mut r = Reader::new(&data[16..]);
                    if program == PUMP_PROGRAM.as_slice() {
                        match disc {
                            D_CREATE => {
                                if let Some(row) = decode_create(&ectx, ev_idx, &mut r) {
                                    KNOWN_MINTS.insert(row.mint.clone());
                                    rows.creates.push(row);
                                }
                            }
                            D_TRADE => {
                                if let Some(mut row) = decode_trade(&ectx, ev_idx, &mut r) {
                                    row.quote_decimals = decimals_of(&row.quote_mint);
                                    rows.trades.push(row);
                                }
                            }
                            D_COMPLETE => {
                                if let Some(row) = decode_complete(&ectx, ev_idx, &mut r) {
                                    rows.completes.push(row);
                                }
                            }
                            D_MIGRATION => {
                                if let Some(row) = decode_migration(&ectx, ev_idx, &mut r) {
                                    rows.completes.push(row);
                                }
                            }
                            _ => {}
                        }
                    } else if program == PUMP_AMM_PROGRAM.as_slice() {
                        match disc {
                            D_AMM_BUY | D_AMM_SELL => {
                                let is_buy = disc == D_AMM_BUY;
                                if let Some(mut row) =
                                    decode_amm_trade(&ectx, ev_idx, is_buy, &mut r, &pool_mints)
                                {
                                    row.base_decimals = decimals_of(&row.base_mint);
                                    row.quote_decimals = decimals_of(&row.quote_mint);
                                    rows.amm_trades.push(row);
                                }
                            }
                            D_AMM_CREATE_POOL => {
                                if let Some(row) = decode_create_pool(&ectx, ev_idx, &mut r) {
                                    rows.amm_pools.push(row);
                                }
                            }
                            _ => {}
                        }
                    }
                    ev_idx = ev_idx.wrapping_add(1);
                }
            }
        }
        tx_row.n_events = ev_idx;
        rows.txs.push(tx_row);
        return rows;
    }

    // Not a pump/PumpSwap transaction: record balance changes of pump mints (transfers,
    // trades on other venues). Successful transactions only (checked above).
    let (Some(pre), Some(post)) = (&meta.pre_token_balances, &meta.post_token_balances) else {
        return rows;
    };
    // Union of account indexes present before or after.
    let mut indexes: Vec<u8> = pre
        .iter()
        .chain(post.iter())
        .filter(|b| is_pump_mint(&b.mint))
        .map(|b| b.account_index)
        .collect();
    indexes.sort_unstable();
    indexes.dedup();
    for idx in indexes {
        let p = pre.iter().find(|b| b.account_index == idx);
        let q = post.iter().find(|b| b.account_index == idx);
        let Some(any) = q.or(p) else { continue };
        let pre_amount = p
            .and_then(|b| b.ui_token_amount.amount.parse::<u64>().ok())
            .unwrap_or(0);
        let post_amount = q
            .and_then(|b| b.ui_token_amount.amount.parse::<u64>().ok())
            .unwrap_or(0);
        if pre_amount == post_amount {
            continue;
        }
        let Some(k) = key_at(idx as usize) else { continue };
        rows.deltas.push(TokenDelta {
            slot: ctx.slot,
            tx_index: ctx.tx_index,
            signature: signature.clone(),
            mint: any.mint.clone(),
            token_account: bs58(k),
            owner: any.owner.clone(),
            pre_amount,
            post_amount,
            decimals: any.ui_token_amount.decimals,
            signer: signer.clone(),
            programs: programs.clone(),
        });
    }
    rows
}

// ---------------------------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
/// Extracts pump.fun and PumpSwap events plus pump-token transfers into ClickHouse.
pub struct PumpEventsPlugin;

impl PumpEventsPlugin {
    /// Creates the plugin.
    pub const fn new() -> Self {
        Self
    }
}

impl Plugin for PumpEventsPlugin {
    fn name(&self) -> &'static str {
        "Pump Events"
    }

    fn on_transaction<'a>(
        &'a self,
        _thread_id: usize,
        _db: Option<Arc<Client>>,
        transaction: &'a TransactionData,
    ) -> PluginFuture<'a> {
        async move {
            if transaction.is_vote {
                return Ok(());
            }
            let rows = extract(transaction);
            if !rows.is_empty() {
                PENDING_BY_SLOT
                    .entry(transaction.slot)
                    .or_default()
                    .append(rows);
            }
            Ok(())
        }
        .boxed()
    }

    fn on_block<'a>(
        &'a self,
        _thread_id: usize,
        db: Option<Arc<Client>>,
        block: &'a BlockData,
    ) -> PluginFuture<'a> {
        let slot = block.slot();
        let was_skipped = block.was_skipped();
        async move {
            if was_skipped {
                return Ok(());
            }
            if let Some((_, rows)) = PENDING_BY_SLOT.remove(&slot)
                && let Some(db) = db
            {
                flush(db, rows);
            }
            Ok(())
        }
        .boxed()
    }

    fn on_load(&self, db: Option<Arc<Client>>) -> PluginFuture<'_> {
        async move {
            log::info!("Pump Events plugin loaded.");
            if let Some(db) = db {
                for ddl in DDL.iter().chain(DDL_ADD) {
                    db.query(ddl).execute().await?;
                }
            } else {
                log::warn!("Pump Events plugin running without ClickHouse; nothing will be saved.");
            }
            Ok(())
        }
        .boxed()
    }

    fn on_exit(&self, db: Option<Arc<Client>>) -> PluginFuture<'_> {
        async move {
            if let Some(db) = db {
                let slots: Vec<u64> = PENDING_BY_SLOT.iter().map(|e| *e.key()).collect();
                let mut all = SlotRows::default();
                for slot in slots {
                    if let Some((_, rows)) = PENDING_BY_SLOT.remove(&slot) {
                        all.append(rows);
                    }
                }
                write_all(db, all).await;
            }
            Ok(())
        }
        .boxed()
    }
}

fn flush(db: Arc<Client>, rows: SlotRows) {
    crate::spawn_tracked_write(async move {
        write_all(db, rows).await;
    });
}

macro_rules! write_table {
    ($fn_name:ident, $ty:ty, $table:literal) => {
        async fn $fn_name(db: Arc<Client>, rows: Vec<$ty>) -> Result<(), clickhouse::error::Error> {
            if rows.is_empty() {
                return Ok(());
            }
            let mut insert = db.insert::<$ty>($table).await?;
            for row in &rows {
                insert.write(row).await?;
            }
            insert.end().await?;
            Ok(())
        }
    };
}

write_table!(write_creates, PumpCreate, "pump_creates");
write_table!(write_trades, PumpTrade, "pump_trades");
write_table!(write_completes, PumpComplete, "pump_completes");
write_table!(write_amm_trades, AmmTrade, "amm_trades");
write_table!(write_amm_pools, AmmPool, "amm_pools");
write_table!(write_deltas, TokenDelta, "token_deltas");
write_table!(write_txs, PumpTx, "pump_txs");

async fn write_all(db: Arc<Client>, rows: SlotRows) {
    let SlotRows {
        creates,
        trades,
        completes,
        amm_trades,
        amm_pools,
        deltas,
        txs,
    } = rows;
    if !creates.is_empty() {
        crate::retry_clickhouse_write("pump_creates", || {
            write_creates(Arc::clone(&db), creates.clone())
        })
        .await;
    }
    if !trades.is_empty() {
        crate::retry_clickhouse_write("pump_trades", || {
            write_trades(Arc::clone(&db), trades.clone())
        })
        .await;
    }
    if !completes.is_empty() {
        crate::retry_clickhouse_write("pump_completes", || {
            write_completes(Arc::clone(&db), completes.clone())
        })
        .await;
    }
    if !amm_trades.is_empty() {
        crate::retry_clickhouse_write("amm_trades", || {
            write_amm_trades(Arc::clone(&db), amm_trades.clone())
        })
        .await;
    }
    if !amm_pools.is_empty() {
        crate::retry_clickhouse_write("amm_pools", || {
            write_amm_pools(Arc::clone(&db), amm_pools.clone())
        })
        .await;
    }
    if !deltas.is_empty() {
        crate::retry_clickhouse_write("token_deltas", || {
            write_deltas(Arc::clone(&db), deltas.clone())
        })
        .await;
    }
    if !txs.is_empty() {
        crate::retry_clickhouse_write("pump_txs", || write_txs(Arc::clone(&db), txs.clone()))
            .await;
    }
}

/// Original tables; columns added later are in `DDL_ADD` so existing databases upgrade in place.
const DDL: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS pump_creates (
        slot UInt64, tx_index UInt32, ev_idx UInt16, signature String, timestamp Int64,
        mint String, name String, symbol String, uri String, bonding_curve String, user String,
        creator Nullable(String),
        virtual_token_reserves Nullable(UInt64), virtual_sol_reserves Nullable(UInt64),
        real_token_reserves Nullable(UInt64), token_total_supply Nullable(UInt64),
        token_program Nullable(String), is_mayhem_mode Nullable(Bool),
        is_cashback_enabled Nullable(Bool), quote_mint Nullable(String)
    ) ENGINE = ReplacingMergeTree ORDER BY (signature, ev_idx)"#,
    r#"CREATE TABLE IF NOT EXISTS pump_trades (
        slot UInt64, tx_index UInt32, ev_idx UInt16, signature String, timestamp Int64,
        mint String, is_buy Bool, user String, sol_amount UInt64, token_amount UInt64,
        virtual_sol_reserves UInt64, virtual_token_reserves UInt64,
        real_sol_reserves Nullable(UInt64), real_token_reserves Nullable(UInt64),
        fee_basis_points Nullable(UInt64), fee Nullable(UInt64), creator Nullable(String),
        creator_fee_basis_points Nullable(UInt64), creator_fee Nullable(UInt64),
        ix_name Nullable(String), mayhem_mode Nullable(Bool), quote_mint Nullable(String),
        quote_amount Nullable(UInt64), virtual_quote_reserves Nullable(UInt64),
        real_quote_reserves Nullable(UInt64)
    ) ENGINE = ReplacingMergeTree ORDER BY (signature, ev_idx)"#,
    r#"CREATE TABLE IF NOT EXISTS pump_completes (
        slot UInt64, tx_index UInt32, ev_idx UInt16, signature String, kind UInt8,
        timestamp Int64, user String, mint String, bonding_curve String,
        mint_amount Nullable(UInt64), sol_amount Nullable(UInt64),
        pool_migration_fee Nullable(UInt64), pool Nullable(String)
    ) ENGINE = ReplacingMergeTree ORDER BY (signature, ev_idx)"#,
    r#"CREATE TABLE IF NOT EXISTS amm_trades (
        slot UInt64, tx_index UInt32, ev_idx UInt16, signature String, timestamp Int64,
        is_buy Bool, pool String, user String, base_mint Nullable(String),
        quote_mint Nullable(String), base_amount UInt64, quote_amount UInt64,
        user_quote_amount UInt64, pool_base_token_reserves UInt64,
        pool_quote_token_reserves UInt64, lp_fee UInt64, protocol_fee UInt64,
        coin_creator Nullable(String), coin_creator_fee Nullable(UInt64)
    ) ENGINE = ReplacingMergeTree ORDER BY (signature, ev_idx)"#,
    r#"CREATE TABLE IF NOT EXISTS amm_pools (
        slot UInt64, tx_index UInt32, ev_idx UInt16, signature String, timestamp Int64,
        pool String, creator String, base_mint String, quote_mint String,
        base_amount_in UInt64, quote_amount_in UInt64, lp_mint Nullable(String),
        coin_creator Nullable(String)
    ) ENGINE = ReplacingMergeTree ORDER BY (signature, ev_idx)"#,
    r#"CREATE TABLE IF NOT EXISTS token_deltas (
        slot UInt64, tx_index UInt32, signature String, mint String, token_account String,
        owner String, pre_amount UInt64, post_amount UInt64, decimals UInt8
    ) ENGINE = ReplacingMergeTree ORDER BY (signature, token_account)"#,
    r#"CREATE TABLE IF NOT EXISTS pump_txs (
        slot UInt64, tx_index UInt32, signature String, signer String, success Bool,
        err LowCardinality(Nullable(String)), fee UInt64, n_signatures UInt8,
        compute_units Nullable(UInt64), programs Array(LowCardinality(String)),
        pump_ixs Array(LowCardinality(String)), ix_arg0 Nullable(UInt64),
        ix_arg1 Nullable(UInt64), n_events UInt16
    ) ENGINE = ReplacingMergeTree ORDER BY signature"#,
];
/// Columns added after the first production run (epochs 1087-1089 hold NULL/defaults).
const DDL_ADD: &[&str] = &[
    r#"ALTER TABLE pump_creates
        ADD COLUMN IF NOT EXISTS virtual_quote_reserves Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS creator_fee_bps Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS is_holder_reward Nullable(Bool),
        ADD COLUMN IF NOT EXISTS depth Nullable(UInt8),
        ADD COLUMN IF NOT EXISTS outer_ix UInt16,
        ADD COLUMN IF NOT EXISTS inner_ix UInt16"#,
    r#"ALTER TABLE pump_trades
        ADD COLUMN IF NOT EXISTS track_volume Nullable(Bool),
        ADD COLUMN IF NOT EXISTS cashback_fee_basis_points Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS cashback Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS buyback_fee_basis_points Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS buyback_fee Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS n_shareholders Nullable(UInt32),
        ADD COLUMN IF NOT EXISTS holder_rewards_bps Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS holder_rewards Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS creator_fee_unclaimed Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS tail String,
        ADD COLUMN IF NOT EXISTS outer_ix UInt16,
        ADD COLUMN IF NOT EXISTS inner_ix UInt16,
        ADD COLUMN IF NOT EXISTS quote_decimals Nullable(UInt8)"#,
    r#"ALTER TABLE pump_completes
        ADD COLUMN IF NOT EXISTS quote_mint Nullable(String),
        ADD COLUMN IF NOT EXISTS outer_ix UInt16,
        ADD COLUMN IF NOT EXISTS inner_ix UInt16"#,
    r#"ALTER TABLE amm_trades
        ADD COLUMN IF NOT EXISTS quote_limit UInt64,
        ADD COLUMN IF NOT EXISTS user_base_token_reserves UInt64,
        ADD COLUMN IF NOT EXISTS user_quote_token_reserves UInt64,
        ADD COLUMN IF NOT EXISTS lp_fee_basis_points UInt64,
        ADD COLUMN IF NOT EXISTS protocol_fee_basis_points UInt64,
        ADD COLUMN IF NOT EXISTS coin_creator_fee_basis_points Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS quote_amount_lp_adjusted UInt64,
        ADD COLUMN IF NOT EXISTS track_volume Nullable(Bool),
        ADD COLUMN IF NOT EXISTS min_base_amount_out Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS ix_name Nullable(String),
        ADD COLUMN IF NOT EXISTS cashback_fee_basis_points Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS cashback Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS buyback_fee_basis_points Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS buyback_fee Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS virtual_quote_reserves Nullable(Int128),
        ADD COLUMN IF NOT EXISTS can_boost Nullable(Bool),
        ADD COLUMN IF NOT EXISTS base_supply Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS holder_rewards_bps Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS holder_rewards Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS creator_fee_unclaimed Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS tail String,
        ADD COLUMN IF NOT EXISTS outer_ix UInt16,
        ADD COLUMN IF NOT EXISTS inner_ix UInt16,
        ADD COLUMN IF NOT EXISTS base_decimals Nullable(UInt8),
        ADD COLUMN IF NOT EXISTS quote_decimals Nullable(UInt8)"#,
    r#"ALTER TABLE amm_pools
        ADD COLUMN IF NOT EXISTS base_mint_decimals UInt8,
        ADD COLUMN IF NOT EXISTS quote_mint_decimals UInt8,
        ADD COLUMN IF NOT EXISTS pool_base_amount UInt64,
        ADD COLUMN IF NOT EXISTS pool_quote_amount UInt64,
        ADD COLUMN IF NOT EXISTS lp_token_amount_out UInt64,
        ADD COLUMN IF NOT EXISTS is_mayhem_mode Nullable(Bool),
        ADD COLUMN IF NOT EXISTS creator_fee_bps Nullable(UInt64),
        ADD COLUMN IF NOT EXISTS can_edit_creator_fee Nullable(Bool),
        ADD COLUMN IF NOT EXISTS is_holder_reward Nullable(Bool),
        ADD COLUMN IF NOT EXISTS outer_ix UInt16,
        ADD COLUMN IF NOT EXISTS inner_ix UInt16"#,
    r#"ALTER TABLE token_deltas
        ADD COLUMN IF NOT EXISTS signer String,
        ADD COLUMN IF NOT EXISTS programs Array(LowCardinality(String))"#,
];

