import type { Address } from '@solana/kit';
import {
    addressBytes, concat, decodeTrade, encodeTrade, lenPrefixed, sha256, u32le, u64le, utf8, validateTrade,
    type TradeContents,
} from '@learned-markets/attestations';

export type Terms = {
    version: number;
    baseFeeBps: number;
    speedFeeBps: number;
    holdFeeBps: number;
    holdSecs: number;
    largeHolderShareBps: number;
    largeHolderFeeBps: number;
    capBps: number;
    perPersonBatchMax: bigint;
};

export type MakerReveal = { buy?: TradeContents; sell?: TradeContents };
const U64_MAX = (1n << 64n) - 1n;
const SCALE = 1_000_000n;
const BPS = 10_000n;

function unsigned(value: bigint, name: string) {
    if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw new RangeError(name + ' exceeds u64');
    return value;
}

function integer(value: number, max: number) {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError('integer exceeds field width');
    return value;
}

function u16le(value: number) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, integer(value, 65535), true);
    return bytes;
}

export function encodeTerms(t: Terms): Uint8Array {
    if (t.version !== 1) throw new Error('unsupported terms version');
    return concat(Uint8Array.of(t.version), u16le(t.baseFeeBps), u16le(t.speedFeeBps), u16le(t.holdFeeBps),
        u32le(integer(t.holdSecs, 0xffff_ffff)), u16le(t.largeHolderShareBps), u16le(t.largeHolderFeeBps),
        u16le(t.capBps), u64le(unsigned(t.perPersonBatchMax, 'perPersonBatchMax')));
}

export function encodeReveal({ buy, sell }: MakerReveal): Uint8Array {
    if (!buy && !sell) throw new Error('maker must reveal at least one side');
    if ((buy && buy.side !== 'buy') || (sell && sell.side !== 'sell')) throw new Error('maker curve side mismatch');
    return concat(Uint8Array.of(1, Number(!!buy)), buy ? encodeTrade(buy) : new Uint8Array(),
        Uint8Array.of(Number(!!sell)), sell ? encodeTrade(sell) : new Uint8Array());
}

export function decodeReveal(bytes: Uint8Array): MakerReveal {
    if (bytes[0] !== 1) throw new Error('unsupported maker reveal version');
    let offset = 1;
    const result: MakerReveal = {};
    for (const side of ['buy', 'sell'] as const) {
        const flag = bytes[offset++];
        if (flag === 0) continue;
        if (flag !== 1) throw new Error('invalid maker presence flag');
        const length = 3 + 16 * (bytes[offset + 2] ?? 0);
        const curve = decodeTrade(bytes.subarray(offset, offset + length));
        if (curve.side !== side) throw new Error('maker curve side mismatch');
        result[side] = curve;
        offset += length;
    }
    if ((!result.buy && !result.sell) || offset !== bytes.length) throw new Error('invalid maker reveal length');
    return result;
}

export function quoteHash(market: Address, batchId: bigint, terms: Terms, reveal: Uint8Array): Uint8Array {
    decodeReveal(reveal);
    return sha256(lenPrefixed(utf8.encode('learned-markets:quote:v1')), addressBytes(market),
        u64le(unsigned(batchId, 'batchId')), encodeTerms(terms), lenPrefixed(reveal));
}

export function qtyAt(curve: TradeContents, price: bigint): bigint {
    validateTrade(curve);
    unsigned(price, 'price');
    const { side, points } = curve;
    const first = points[0]!;
    if (price < first.price) return side === 'buy' ? first.quantity : 0n;
    if (price === first.price) return first.quantity;
    for (let index = 1; index < points.length; index++) {
        const left = points[index - 1]!;
        const right = points[index]!;
        if (price <= right.price) {
            // Both weights are nonnegative. Integer division rounds down on either slope.
            return (left.quantity * (right.price - price) + right.quantity * (price - left.price)) /
                (right.price - left.price);
        }
    }
    return side === 'sell' ? points.at(-1)!.quantity : 0n;
}

export type FeeInput = {
    side: 'buy' | 'sell';
    fill: bigint;
    price: bigint;
    baseBefore: bigint;
    lastBuyTs: bigint;
    now: bigint;
    totalSupply: bigint;
    maxTotalFeeBps: number;
};

export function feeFor(t: Terms, x: FeeInput) {
    for (const field of ['fill', 'price', 'baseBefore', 'totalSupply'] as const) unsigned(x[field], field);
    if (x.price === 0n || x.totalSupply === 0n) throw new RangeError('price and supply must be positive');
    const gross = x.fill * x.price;
    let bps = BigInt(t.baseFeeBps);
    let notional: bigint;
    if (x.side === 'buy') {
        notional = (gross + SCALE - 1n) / SCALE;
        const share = (x.baseBefore + x.fill) * BPS / x.totalSupply;
        if (share > BigInt(t.largeHolderShareBps)) bps += BigInt(t.largeHolderFeeBps);
    } else {
        if (x.fill > x.baseBefore) throw new RangeError('insufficient base');
        notional = gross / SCALE;
        const elapsed = x.now > x.lastBuyTs ? x.now - x.lastBuyTs : 0n;
        const holdSecs = BigInt(t.holdSecs);
        if (elapsed < holdSecs) bps += BigInt(t.holdFeeBps) * (holdSecs - elapsed) / holdSecs;
        if (x.baseBefore > 0n) bps += BigInt(t.speedFeeBps) * x.fill / x.baseBefore;
    }
    if (bps > BigInt(x.maxTotalFeeBps)) bps = BigInt(x.maxTotalFeeBps);
    return { notional: unsigned(notional, 'notional'), bps: Number(bps), fee: (notional * bps + BPS - 1n) / BPS };
}
