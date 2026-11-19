import type { Address } from '@solana/kit';
import { INTENT_PAYLOAD_DOMAIN, INTENT_PAYLOAD_VERSION } from './constants.ts';
import { addressBytes, bytesToAddress, concat, lenPrefixed, sha256, u64le, utf8 } from './bytes.ts';

/** Matches `IntentKind` in the program (borsh enum index). */
export const IntentKind = { Trade: 0, Nomination: 1 } as const;
export type IntentKind = (typeof IntentKind)[keyof typeof IntentKind];

export const MAX_CURVE_POINTS = 16;

export type CurvePoint = { price: bigint; quantity: bigint };
export type TradeContents = { side: 'buy' | 'sell'; points: CurvePoint[] };
export type NominationContents = { candidate: Address };

export class PayloadError extends Error {
    readonly code = 'MalformedPayload';
}

/**
 * payload_hash = sha256(len‖DOMAIN ‖ u8 version ‖ len‖app_scope ‖ len‖network ‖ u8 kind ‖ target ‖ len‖contents)
 * Same as `payload::payload_hash` in the program.
 */
export function payloadHash(appScope: string, network: string, kind: IntentKind, target: Address, contents: Uint8Array): Uint8Array {
    return sha256(
        lenPrefixed(utf8.encode(INTENT_PAYLOAD_DOMAIN)),
        Uint8Array.of(INTENT_PAYLOAD_VERSION),
        lenPrefixed(utf8.encode(appScope)),
        lenPrefixed(utf8.encode(network)),
        Uint8Array.of(kind),
        addressBytes(target),
        lenPrefixed(contents),
    );
}

const U64_MAX = (1n << 64n) - 1n;

export function validateTrade(t: TradeContents): void {
    const n = t.points.length;
    if (n < 1 || n > MAX_CURVE_POINTS) throw new PayloadError(`curve must have 1..${MAX_CURVE_POINTS} points`);
    for (const p of t.points) {
        if (p.price <= 0n || p.price > U64_MAX || p.quantity < 0n || p.quantity > U64_MAX)
            throw new PayloadError('price must be in 1..u64::MAX and quantity in 0..u64::MAX');
    }
    if (!t.points.some(p => p.quantity > 0n)) throw new PayloadError('curve has no quantity');
    for (let i = 1; i < n; i++) {
        const [a, b] = [t.points[i - 1], t.points[i]];
        if (!(a.price < b.price)) throw new PayloadError('prices must be strictly increasing');
        if (t.side === 'buy' ? a.quantity < b.quantity : a.quantity > b.quantity)
            throw new PayloadError(`${t.side} quantities must be ${t.side === 'buy' ? 'non-increasing' : 'non-decreasing'} in price`);
    }
}

/** u8 version(=1) ‖ u8 side ‖ u8 n ‖ n × (u64 price ‖ u64 quantity) */
export function encodeTrade(t: TradeContents): Uint8Array {
    validateTrade(t);
    return concat(
        Uint8Array.of(1, t.side === 'buy' ? 0 : 1, t.points.length),
        ...t.points.flatMap(p => [u64le(p.price), u64le(p.quantity)]),
    );
}

export function decodeTrade(bytes: Uint8Array): TradeContents {
    if (bytes.length < 3 || bytes[0] !== 1) throw new PayloadError('unsupported trade contents version');
    if (bytes[1] !== 0 && bytes[1] !== 1) throw new PayloadError('invalid side');
    const n = bytes[2];
    if (n < 1 || n > MAX_CURVE_POINTS || bytes.length !== 3 + n * 16) throw new PayloadError('invalid point count/length');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const points: CurvePoint[] = [];
    for (let i = 0; i < n; i++) {
        const o = 3 + i * 16;
        points.push({ price: view.getBigUint64(o, true), quantity: view.getBigUint64(o + 8, true) });
    }
    const t: TradeContents = { side: bytes[1] === 0 ? 'buy' : 'sell', points };
    validateTrade(t);
    return t;
}

const DEFAULT_ADDRESS = '11111111111111111111111111111111';

/** u8 version(=1) ‖ candidate */
export function encodeNomination(n: NominationContents): Uint8Array {
    if (n.candidate === DEFAULT_ADDRESS) throw new PayloadError('candidate must be set');
    return concat(Uint8Array.of(1), addressBytes(n.candidate));
}

export function decodeNomination(bytes: Uint8Array): NominationContents {
    if (bytes.length !== 33 || bytes[0] !== 1) throw new PayloadError('invalid nomination contents');
    const candidate = bytesToAddress(bytes.subarray(1));
    if (candidate === DEFAULT_ADDRESS) throw new PayloadError('candidate must be set');
    return { candidate };
}

export function validateContents(kind: IntentKind, contents: Uint8Array): void {
    if (kind === IntentKind.Trade) decodeTrade(contents);
    else if (kind === IntentKind.Nomination) decodeNomination(contents);
    else throw new PayloadError('unknown intent kind');
}
