import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { bytesToAddress, decodeTrade, fromHex, toHex } from '@learned-markets/attestations';
import { decodeReveal, encodeReveal, encodeTerms, feeFor, qtyAt, quoteHash, termsFromWire } from '../src/settlement-v2.ts';

test('reproduce shared canonical settlement vectors', async () => {
    const vectors = JSON.parse(await readFile(new URL('../../../fixtures/settlement-vectors.json', import.meta.url), 'utf8'));
    const terms = termsFromWire(vectors.terms.schedule);
    assert.equal(toHex(encodeTerms(terms)), vectors.terms.bytes_hex);
    const quote = vectors.quote;
    const reveal = encodeReveal({
        buy: quote.buy_contents_hex ? decodeTrade(fromHex(quote.buy_contents_hex)) : undefined,
        sell: quote.sell_contents_hex ? decodeTrade(fromHex(quote.sell_contents_hex)) : undefined,
    });
    assert.deepEqual(encodeReveal(decodeReveal(reveal)), reveal);
    assert.equal(toHex(reveal), quote.maker_reveal_hex);
    assert.equal(toHex(quoteHash(bytesToAddress(fromHex(quote.market_hex)), BigInt(quote.batch_id), terms, reveal)), quote.hash_hex);
    for (const v of vectors.qty_at) assert.equal(qtyAt(decodeTrade(fromHex(v.contents_hex)), BigInt(v.price)), BigInt(v.quantity));
    for (const v of vectors.fees) {
        const actual = feeFor(terms, { side: v.side, fill: BigInt(v.fill), price: BigInt(v.price), baseBefore: BigInt(v.base_before),
            now: BigInt(v.now), lastBuyTs: BigInt(v.last_buy_ts), totalSupply: BigInt(v.total_supply), maxTotalFeeBps: v.max_total_fee_bps });
        assert.equal(actual.fee, BigInt(v.fee));
        assert.equal(actual.notional, BigInt(v.notional));
    }
});

test('replay the position balances, fee shares and market counters of the two-chunk batch', async () => {
    const vectors = JSON.parse(await readFile(new URL('../../../fixtures/settlement-vectors.json', import.meta.url), 'utf8'));
    const batch = vectors.two_chunk_batch;
    const terms = termsFromWire(vectors.terms.schedule);
    const numbers = (values: Record<string,string>) => Object.fromEntries(Object.entries(values).map(([k,v])=>[k,BigInt(v)]));
    const market = numbers(batch.before.market);
    const positions = Object.fromEntries(Object.entries(batch.before.positions as Record<string,Record<string,string>>)
        .map(([k,v])=>[k,numbers(v)]));
    const acc = numbers(batch.before.accumulators);
    const wire = (obj: unknown) => JSON.parse(JSON.stringify(obj, (_,v) => typeof v === 'bigint' ? v.toString() : v));
    for (const chunk of batch.chunks) {
        for (const record of chunk.fills) {
            const position = positions[record.participant], fill = BigInt(record.fill), price = BigInt(batch.clearing_price);
            const curve = decodeTrade(fromHex(record.contents_hex));
            assert.equal(curve.side, record.side);
            assert.ok(fill <= qtyAt(curve,price));
            const { fee, notional } = feeFor(terms,{side:curve.side, fill, price, baseBefore:position.base,
                now:BigInt(batch.now),lastBuyTs:position.last_buy_ts,totalSupply:market.total_supply,maxTotalFeeBps:batch.max_total_fee_bps});
            assert.equal(fee.toString(),record.fee);
            assert.equal(notional.toString(),record.notional);
            if (position.batch_seen !== BigInt(batch.batch_id)) {
                position.batch_seen = BigInt(batch.batch_id);
                position.batch_bought = position.batch_sold = 0n;
            }
            const buy = record.side === 'buy';
            const baseDelta = buy ? fill : -fill;
            const quoteDelta = (buy ? -notional : notional) - fee;
            market.total_user_base += baseDelta;
            market.total_user_quote += quoteDelta;
            position.base += baseDelta;
            position.quote += quoteDelta;
            position.fees_paid += fee;
            position[buy ? 'batch_bought':'batch_sold'] += fill;
            position[buy ? 'total_bought':'total_sold'] += fill;
            if (buy && fill > 0n) position.last_buy_ts = BigInt(batch.now);
            acc[buy ? 'acc_user_buy':'acc_user_sell'] += fill;
            acc[buy ? 'acc_buyer_paid':'acc_seller_recv'] += notional;
            acc.acc_fees += fee;
            acc.intents_settled++;
        }
        assert.deepEqual(wire({market,positions,accumulators:acc}),{market:chunk.market,positions:chunk.positions,accumulators:chunk.accumulators});
    }
    const net = acc.acc_user_buy - acc.acc_user_sell, trading = acc.acc_buyer_paid - acc.acc_seller_recv;
    const deployer = ['Regular','Rookie'].includes(batch.stage) ? acc.acc_fees * BigInt(batch.deployer_fee_bps) / 10000n : 0n;
    const platform = (acc.acc_fees - deployer) * BigInt(batch.platform_fee_share_bps) / 10000n;
    const maker = acc.acc_fees - deployer - platform;
    market.maker_base -= net;
    market.maker_quote += trading + maker;
    market.maker_trading_quote += trading;
    market.maker_fee_income += maker;
    market.platform_fees += platform;
    market.deployer_fees += deployer;
    market.last_price = BigInt(batch.clearing_price);
    market.last_settled_batch = BigInt(batch.batch_id);
    if (-market.maker_quote > market.risk_drawn_peak) market.risk_drawn_peak = -market.maker_quote;
    assert.deepEqual(wire({ market,positions,maker_net:net,fee_split:{platform,maker,deployer} }),batch.after);
});
