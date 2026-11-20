import type { Terms } from './market.ts';

export type WireTerms = {
    version: number; base_fee_bps: number; speed_fee_bps: number; hold_fee_bps: number; hold_secs: number;
    large_holder_share_bps: number; large_holder_fee_bps: number; cap_bps: number; per_person_batch_max: string;
};

/** Decimal strings preserve all 64 bits across JSON.parse. Reject lossy JS numbers. */
export function atoms(value: string): bigint {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error('expected unsigned decimal string');
    const result = BigInt(value);
    if (result >= 1n << 64n) throw new RangeError('amount exceeds u64');
    return result;
}

export function termsFromWire(t: WireTerms): Terms {
    return { version: t.version, baseFeeBps: t.base_fee_bps, speedFeeBps: t.speed_fee_bps, holdFeeBps: t.hold_fee_bps,
        holdSecs: t.hold_secs, largeHolderShareBps: t.large_holder_share_bps, largeHolderFeeBps: t.large_holder_fee_bps,
        capBps: t.cap_bps, perPersonBatchMax: atoms(t.per_person_batch_max) };
}
export function jsonWire(value: unknown): string {
    return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
}
