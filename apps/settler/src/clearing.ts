import { decodeTrade, fromHex, type TradeContents } from '@learned-markets/attestations';
import { atoms, decodeReveal, feeFor, qtyAt, termsFromWire, type WireTerms } from '@learned-markets/client/settlement-v2';

export type PublicMarket = {
    stage: 'Line' | 'Rookie' | 'Regular'; last_price: string; total_supply: string; maker_base: string;
    maker_quote: string; risk_allowance: string;
    bounds: { max_total_fee_bps: number; max_hold_secs: number; min_cap_bps: number; max_cap_bps: number;
        rookie_max_cap_bps: number; max_per_person_batch_max: string };
    limits: { max_net_sell_per_batch: string; max_net_buy_per_batch: string;
        max_price_move_bps: number; rookie_max_price_move_bps: number };
};
export type Position = { base: string; external_base: string; quote: string; last_buy_ts: string };
export type Order = { intent: string; participant: string; contents_hex: string; position: Position };
export type ClearRequest = {
    market: PublicMarket; terms: WireTerms; last_price: string; now: string; user_curves: Order[]; maker_reveal: string;
};
export type ClearResult = { clearing_price: string; fills: { intent: string; fill: string }[] };

const U64_MAX = (1n << 64n) - 1n;
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
const max = (a: bigint, b: bigint) => a > b ? a : b;
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
const lex = (a: string, b: string) => a < b ? -1 : Number(a > b);
function lastTrue(low: bigint, high: bigint, predicate: (x: bigint) => boolean) {
    let left = low - 1n, right = high + 1n;
    while (right - left > 1n) {
        const middle = (left + right) / 2n;
        if (predicate(middle)) left = middle;
        else right = middle;
    }
    return left;
}

/** Demand is non-increasing and supply non-decreasing across all integer price ticks. */
export function clearingPrice(curves: TradeContents[], market: PublicMarket) {
    const prev = atoms(market.last_price);
    const rail = market.stage === 'Regular' ? market.limits.max_price_move_bps : market.limits.rookie_max_price_move_bps;
    const delta = prev * BigInt(rail) / 10_000n;
    const low = max(1n, prev - delta), high = min(U64_MAX, prev + delta);
    const demand = curves.filter(c => c.side === 'buy'), supply = curves.filter(c => c.side === 'sell');
    const quantity = (curves: TradeContents[], p: bigint) => sum(curves.map(c => qtyAt(c, p)));
    const crossing = lastTrue(low, high, p => quantity(demand, p) >= quantity(supply, p));
    const volume = (p: bigint) => min(quantity(demand, p), quantity(supply, p));
    const peak = max(volume(max(low, crossing)), volume(min(high, crossing + 1n)));
    const first = lastTrue(low, high, p => quantity(supply, p) < peak) + 1n;
    const last = lastTrue(low, high, p => quantity(demand, p) >= peak);
    return min(max(prev, first), last);
}

type Bid = { key: string; curve: TradeContents; capacity: bigint };
function allocate(offers: Bid[], price: bigint, volume: bigint) {
    const quantities = (p: bigint) => offers.map(b => min(b.capacity, qtyAt(b.curve, p)));
    let fills = quantities(price);
    if (!volume) fills.fill(0n);
    else if (sum(fills) > volume) {
        const sell = offers[0].curve.side === 'sell';
        const marginal = sell ? lastTrue(1n, price, p => sum(quantities(p)) < volume) + 1n
            : lastTrue(price, U64_MAX, p => sum(quantities(p)) >= volume);
        const adjacent = sell ? marginal - 1n : marginal + 1n;
        const better = adjacent > 0n && adjacent <= U64_MAX ? quantities(adjacent) : offers.map(() => 0n);
        const weights = quantities(marginal).map((q, i) => q - better[i]);
        const total = sum(weights), available = volume - sum(better);
        fills = better.map((q, i) => q + weights[i] * available / total);
        const priority = offers.map((bid, i) => ({ key: bid.key, i, remainder: weights[i] * available % total }))
            .sort((a, b) => a.remainder === b.remainder ? lex(a.key, b.key) : a.remainder > b.remainder ? -1 : 1);
        const extra = Number(volume - sum(fills)); // strictly less than offers.length
        for (const { i } of priority.slice(0, extra)) fills[i]++;
    }
    return offers.map((bid, i) => [bid.key, fills[i]] as const);
}

/** Independent integer replay of the published priority and risk rules. */
export function replayClearing(input: ClearRequest): ClearResult {
    const { market } = input;
    const terms = termsFromWire(input.terms);
    const orders = input.user_curves.map(o => ({ ...o, curve: decodeTrade(fromHex(o.contents_hex)) }))
        .sort((a, b) => a.curve.side === b.curve.side ? lex(a.intent, b.intent) : a.curve.side === 'buy' ? -1 : 1);
    if (new Set(orders.map(o => o.intent)).size !== orders.length) throw new Error('duplicate order');
    const maker = decodeReveal(fromHex(input.maker_reveal));
    const curves = orders.map(o => o.curve);
    if (maker.buy) curves.push(maker.buy);
    if (maker.sell) curves.push(maker.sell);
    const price = clearingPrice(curves, market), supply = atoms(market.total_supply);
    const holdCap = supply * BigInt(terms.capBps) / 10_000n;
    const reserves = new Map<string, { buy: bigint; sell: bigint; quote: bigint }>();
    const bids: Bid[] = [];
    for (const order of orders) {
        const r = reserves.get(order.participant) ?? { buy: 0n, sell: 0n, quote: 0n };
        const base = atoms(order.position.base);
        let capacity = min(qtyAt(order.curve, price), terms.perPersonBatchMax - r.buy - r.sell);
        if (order.curve.side === 'sell') {
            capacity = min(capacity, base - r.sell);
            r.sell += capacity;
        } else {
            capacity = min(capacity, max(0n, holdCap - base - atoms(order.position.external_base) - r.buy));
            const cost = (fill: bigint) => {
                const { notional, fee } = feeFor(terms, { side: 'buy', fill, price, baseBefore: base + r.buy,
                    lastBuyTs: BigInt(order.position.last_buy_ts), now: BigInt(input.now), totalSupply: supply,
                    maxTotalFeeBps: market.bounds.max_total_fee_bps });
                return notional + fee;
            };
            const budget = atoms(order.position.quote) - r.quote;
            capacity = lastTrue(0n, capacity, q => q * price <= budget * 1_000_000n && cost(q) <= budget);
            r.quote += cost(capacity);
            r.buy += capacity;
        }
        reserves.set(order.participant, r);
        bids.push({ key: order.intent, curve: order.curve, capacity });
    }
    if (maker.buy) bids.push({ key: '', curve: maker.buy, capacity: min(atoms(market.limits.max_net_buy_per_batch),
        (BigInt(market.maker_quote) + atoms(market.risk_allowance)) * 1_000_000n / price) });
    if (maker.sell) bids.push({ key: '', curve: maker.sell, capacity: min(atoms(market.limits.max_net_sell_per_batch), atoms(market.maker_base)) });
    const buys = bids.filter(b => b.curve.side === 'buy'), sells = bids.filter(b => b.curve.side === 'sell');
    const available = (offers: Bid[]) => sum(offers.map(b => min(b.capacity, qtyAt(b.curve, price))));
    const volume = min(available(buys), available(sells));
    const fills = new Map([...allocate(buys, price, volume), ...allocate(sells, price, volume)]);
    return { clearing_price: price.toString(), fills: orders.map(o => ({ intent: o.intent, fill: fills.get(o.intent)!.toString() })) };
}
