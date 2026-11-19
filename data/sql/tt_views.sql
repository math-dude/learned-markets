-- Token Terminal-shaped views over the raw pump-events tables.
--
-- The raw tables stay the source of truth: they keep every event field, raw integer amounts
-- and pump-specific state (reserves, fee splits, slippage limits). These views only reshape
-- them to Token Terminal's catalog schemas (tokenterminal.com/docs/catalog), so analysis written
-- against TT (dex.trades, tokens.registry, dex pools, tokens.transfers) runs on our data.
--
-- Conventions copied from TT:
--   chain_id = 'solana'; token_id = '<mint>-solana'; dex_pool_id = '<pool address>-solana'.
--   dex trades: amounts are decimal-adjusted whole units, always positive;
--               fee_rate is a decimal fraction of the swap size.
--   transfers:  amount_raw is the smallest unit as a decimal string.
-- Extra columns beyond TT's (trader, raw amounts, reserves) are appended at the end.
--
-- Load: clickhouse client --multiquery < tt_views.sql

-- SOL-quoted bonding curves store the default (all-zero) pubkey as quote_mint.
CREATE OR REPLACE FUNCTION lm_quote AS (m) ->
    if(m IS NULL OR m = '11111111111111111111111111111111',
       'So11111111111111111111111111111111111111112', assumeNotNull(m));

-- Known quote decimals; pump tokens are 6. Unknown quote mints get NULL whole-unit amounts
-- (raw amounts are always present).
CREATE OR REPLACE FUNCTION lm_decimals AS (m) -> multiIf(
    m = 'So11111111111111111111111111111111111111112', 9,
    m = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6,   -- USDC
    m = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY4MSWc4yRuP7FGM', 6,   -- USDT
    endsWith(m, 'pump'), 6,
    NULL);

CREATE OR REPLACE VIEW tt_dex_trades AS
SELECT
    toDateTime(t.timestamp, 'UTC')                         AS block_timestamp,
    t.signature                                            AS transaction_hash,
    toInt64(t.ev_idx)                                      AS log_index,
    if(c.bonding_curve = '', NULL, concat(c.bonding_curve, '-solana')) AS dex_pool_id,
    'pumpfun-launchpad'                                    AS app_id,
    'solana'                                               AS chain_id,
    'pump'                                                 AS project_id,   -- TT slug unverified
    concat(if(t.is_buy, lm_quote(t.quote_mint), t.mint), '-solana') AS token_in_id,
    concat(if(t.is_buy, t.mint, lm_quote(t.quote_mint)), '-solana') AS token_out_id,
    -- buyback/cashback/holder-reward bps are shares carved out of these fees, not extra.
    (coalesce(t.fee_basis_points, 0) + coalesce(t.creator_fee_basis_points, 0)) / 10000 AS fee_rate,
    -- Non-SOL curves report sol_amount = 0 and put the amount in quote_amount; older events
    -- have no quote_amount (SOL only). Same split for virtual/real *_reserves.
    if(t.is_buy, coalesce(t.quote_amount, t.sol_amount) / pow(10, coalesce(t.quote_decimals, lm_decimals(lm_quote(t.quote_mint)))),
                 t.token_amount / 1e6)                     AS amount_in,
    if(t.is_buy, t.token_amount / 1e6,
                 coalesce(t.quote_amount, t.sol_amount) / pow(10, coalesce(t.quote_decimals, lm_decimals(lm_quote(t.quote_mint))))) AS amount_out,
    -- extras
    t.user                                                 AS trader,
    if(t.is_buy, coalesce(t.quote_amount, t.sol_amount), t.token_amount) AS amount_in_raw,
    if(t.is_buy, t.token_amount, coalesce(t.quote_amount, t.sol_amount)) AS amount_out_raw,
    t.slot, t.tx_index, t.outer_ix AS outer_event_index, t.inner_ix AS event_index
FROM pump_trades AS t FINAL
LEFT ANY JOIN (SELECT mint, bonding_curve FROM pump_creates FINAL) AS c ON c.mint = t.mint

UNION ALL

SELECT
    toDateTime(a.timestamp, 'UTC'),
    a.signature,
    toInt64(a.ev_idx),
    concat(a.pool, '-solana'),
    'pumpfun-amm',
    'solana',
    'pump',
    concat(if(a.is_buy, lm_quote(a.quote_mint), coalesce(a.base_mint, '')), '-solana'),
    concat(if(a.is_buy, coalesce(a.base_mint, ''), lm_quote(a.quote_mint)), '-solana'),
    (a.lp_fee_basis_points + a.protocol_fee_basis_points
        + coalesce(a.coin_creator_fee_basis_points, 0)) / 10000,
    if(a.is_buy, a.quote_amount / pow(10, coalesce(a.quote_decimals, lm_decimals(lm_quote(a.quote_mint)))),
                 a.base_amount / pow(10, coalesce(a.base_decimals, lm_decimals(coalesce(a.base_mint, ''))))),
    if(a.is_buy, a.base_amount / pow(10, coalesce(a.base_decimals, lm_decimals(coalesce(a.base_mint, '')))),
                 a.quote_amount / pow(10, coalesce(a.quote_decimals, lm_decimals(lm_quote(a.quote_mint))))),
    a.user,
    if(a.is_buy, a.quote_amount, a.base_amount),
    if(a.is_buy, a.base_amount, a.quote_amount),
    a.slot, a.tx_index, a.outer_ix, a.inner_ix
FROM amm_trades AS a FINAL;

-- TT tokens.registry
CREATE OR REPLACE VIEW tt_tokens AS
SELECT
    concat(mint, '-solana')            AS token_id,
    'solana'                           AS chain_id,
    mint                               AS token_address,
    symbol,
    name,
    toInt64(6)                         AS decimals,
    toDateTime(timestamp, 'UTC')       AS created_at,
    -- extras
    uri, creator, token_program, is_mayhem_mode, is_cashback_enabled
FROM pump_creates FINAL;

-- TT dex pools registry: bonding curves (one per create) and PumpSwap pools.
-- fee_tier is NULL for both: pump charges per-swap fees tiered by market cap.
CREATE OR REPLACE VIEW tt_dex_pools AS
SELECT
    concat(bonding_curve, '-solana')                AS dex_pool_id,
    'pumpfun-launchpad'                             AS app_id,
    'solana'                                        AS chain_id,
    'pump'                                          AS project_id,
    bonding_curve                                   AS pool_address,
    concat(symbol, '-SOL')                          AS pool_name,
    concat(symbol, '-SOL')                          AS pool_display_name,
    CAST(NULL AS Nullable(Float64))                 AS fee_tier,
    toDateTime(timestamp, 'UTC')                    AS created_at,
    CAST(NULL AS Nullable(String))                  AS hooks_address,
    [concat(mint, '-solana'),
     concat(lm_quote(quote_mint), '-solana')] AS token_ids
FROM pump_creates FINAL
UNION ALL
SELECT
    concat(p.pool, '-solana'), 'pumpfun-amm', 'solana', 'pump', p.pool,
    concat(coalesce(c.symbol, p.base_mint), '-', if(p.quote_mint = 'So11111111111111111111111111111111111111112', 'SOL', p.quote_mint)),
    concat(coalesce(c.symbol, p.base_mint), '-', if(p.quote_mint = 'So11111111111111111111111111111111111111112', 'SOL', p.quote_mint)),
    CAST(NULL AS Nullable(Float64)),
    toDateTime(p.timestamp, 'UTC'),
    CAST(NULL AS Nullable(String)),
    [concat(p.base_mint, '-solana'), concat(p.quote_mint, '-solana')]
FROM amm_pools AS p FINAL
LEFT ANY JOIN (SELECT mint, symbol FROM pump_creates FINAL) AS c ON c.mint = p.base_mint;

-- TT tokens.transfers, approximated from balance deltas. Not 1:1 with TT: one row per
-- (transaction, token account) net change rather than per transfer instruction, so there is no
-- from/to pairing. event_type = 'credit' or 'debit'; to_owner holds the account's owner.
CREATE OR REPLACE VIEW tt_token_transfers AS
SELECT
    toStartOfMonth(s.block_time)                    AS partition_key,
    s.block_time                                    AS block_timestamp,
    toInt64(d.slot)                                 AS block_number,
    d.signature                                     AS transaction_hash,
    toInt64(d.tx_index)                             AS transaction_index,
    CAST(NULL AS Nullable(Int64))                   AS outer_event_index,
    CAST(NULL AS Nullable(Int64))                   AS event_index,
    'solana'                                        AS chain_id,
    'spl'                                           AS token_type,
    concat(d.mint, '-solana')                       AS token_id,
    d.mint                                          AS token_address,
    if(d.post_amount > d.pre_amount, 'credit', 'debit') AS event_type,
    if(d.post_amount < d.pre_amount, d.token_account, NULL) AS from_address,
    if(d.post_amount > d.pre_amount, d.token_account, NULL) AS to_address,
    d.owner                                         AS to_owner,
    CAST(NULL AS Nullable(String))                  AS authority_address,
    d.signer                                        AS transaction_signer,
    arrayElement(d.programs, 1)                     AS executing_account,
    toString(if(d.post_amount > d.pre_amount, d.post_amount - d.pre_amount, d.pre_amount - d.post_amount)) AS amount_raw,
    -- extras
    d.programs, d.pre_amount, d.post_amount, d.decimals
FROM token_deltas AS d FINAL
LEFT ANY JOIN (SELECT slot, block_time FROM jetstreamer_slot_status FINAL) AS s ON s.slot = d.slot;
