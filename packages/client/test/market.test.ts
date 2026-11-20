import assert from 'node:assert/strict';
import test from 'node:test';
import { address, blockhash, createNoopSigner, type Address, type Instruction } from '@solana/kit';
import { bytesToAddress, type TradeContents } from '@learned-markets/attestations';
import { buildSettlementTxs, decodeReveal, encodeReveal, encodeTerms, feeFor, qtyAt, type Terms } from '../src/settlement-v2.ts';

const curve: TradeContents = { side: 'buy', points: [{ price: 10n, quantity: 11n }, { price: 13n, quantity: 4n }] };
const terms: Terms = { version: 1, baseFeeBps: 100, speedFeeBps: 300, holdFeeBps: 150, holdSecs: 20,
    largeHolderShareBps: 100, largeHolderFeeBps: 50, capBps: 200, perPersonBatchMax: 1n << 60n };

test('canonical reveal binds side, point count and exact end', () => {
    const reveal = encodeReveal({ buy: curve });
    assert.deepEqual(decodeReveal(reveal), { buy: curve });
    assert.throws(() => decodeReveal(reveal.subarray(0, -1)));
    assert.throws(() => decodeReveal(new Uint8Array([...reveal, 1])));
    assert.throws(() => encodeReveal({ sell: curve }));
    assert.throws(() => decodeReveal(Uint8Array.of(1, 0, 0)));
    assert.throws(() => encodeTerms({ ...terms, capBps: 65536 }));
    assert.equal(encodeTerms(terms).length, 25);
});
test('descending interpolation rounds down even one atom from an endpoint', () => {
    assert.deepEqual([1n, 10n, 11n, 12n, 13n, 14n].map(price => qtyAt(curve, price)), [11n, 11n, 8n, 6n, 4n, 0n]);
});
test('notional, strict large-holder threshold, two sell fees and zero hold duration', () => {
    const base = { fill: 500n, price: 1_000_001n, baseBefore: 500n, lastBuyTs: 100n,
        now: 110n, totalSupply: 100_000n, maxTotalFeeBps: 1000 };
    assert.deepEqual(feeFor(terms, { ...base, side: 'buy' }), { notional: 501n, bps: 100, fee: 6n });
    assert.deepEqual(feeFor(terms, { ...base, side: 'sell' }), { notional: 500n, bps: 475, fee: 24n });
    assert.equal(feeFor({ ...terms, holdSecs: 0 }, { ...base, side: 'sell' }).bps, 400);
});
test('packer preserves fill order, isolates duplicate participants and fits the wire limit', () => {
    const payer = createNoopSigner(address('11111111111111111111111111111111'));
    const programAddress = bytesToAddress(new Uint8Array(32).fill(7));
    const ix = (bytes: number): Instruction => ({ programAddress, accounts: [], data: new Uint8Array(bytes) });
    const make = (size: number) => ({ payer, lifetime: { blockhash: blockhash(payer.address), lastValidBlockHeight: 99n },
        tables: {}, begin: ix(160), chunk: (xs: { participant: Address }[]) => ix(xs.length * size), finalize: ix(42) });
    const fills = Array.from({ length: 10 }, (_, index) => ({ participant: bytesToAddress(new Uint8Array(32).fill(index % 4 + 1)) }));
    assert.deepEqual(buildSettlementTxs(make(15), fills.slice(0, 2)).map(p => [p.begins, p.fills, p.finalizes]), [[true, 2, true]]);
    const packed = buildSettlementTxs(make(200), fills);
    assert.equal(packed.reduce((s, p) => s + p.fills, 0), 10);
    assert.equal(packed[0].begins, true);
    assert.equal(packed.at(-1)!.finalizes, true);
    assert.throws(() => buildSettlementTxs(make(1500), fills));
});
