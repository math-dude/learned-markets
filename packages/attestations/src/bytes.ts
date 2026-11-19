import { createHash } from 'node:crypto';
import { getAddressDecoder, getAddressEncoder, type Address } from '@solana/kit';

export const utf8 = new TextEncoder();

export function sha256(...parts: Uint8Array[]): Uint8Array {
    const h = createHash('sha256');
    for (const p of parts) h.update(p);
    return new Uint8Array(h.digest());
}

export function u32le(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
}

export function u64le(n: bigint): Uint8Array {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
}

export function lenPrefixed(bytes: Uint8Array): Uint8Array {
    return concat(u32le(bytes.length), bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

export function toHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
    if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('invalid hex');
    return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function addressBytes(a: Address): Uint8Array {
    return new Uint8Array(getAddressEncoder().encode(a));
}

export function bytesToAddress(b: Uint8Array): Address {
    if (b.length !== 32) throw new Error('address must be 32 bytes');
    return getAddressDecoder().decode(b);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
