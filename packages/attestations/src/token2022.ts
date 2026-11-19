import type { Address } from '@solana/kit';
import { bytesToAddress } from './bytes.ts';

/** Mirrors `sas::parse_badge_mint` / `parse_token_account` in the program. */
const BASE_ACCOUNT_LEN = 165;
const TLV_START = 166;
const EXT_NON_TRANSFERABLE = 9;
const EXT_TOKEN_GROUP_MEMBER = 23;

export type BadgeMint = {
    mintAuthority: Address | null;
    supply: bigint;
    decimals: number;
    nonTransferable: boolean;
    groupMember: { mint: Address; group: Address } | null;
};

export type BadgeTokenAccount = { mint: Address; owner: Address; amount: bigint; state: number };

function findExtension(data: Uint8Array, ext: number): Uint8Array | null {
    let o = TLV_START;
    while (o + 4 <= data.length) {
        const ty = data[o] | (data[o + 1] << 8);
        const len = data[o + 2] | (data[o + 3] << 8);
        const end = o + 4 + len;
        if (end > data.length) return null;
        if (ty === ext) return data.subarray(o + 4, end);
        if (ty === 0 && len === 0) return null;
        o = end;
    }
    return null;
}

export function parseBadgeMint(data: Uint8Array): BadgeMint {
    if (data.length <= TLV_START || data[BASE_ACCOUNT_LEN] !== 1) throw new Error('MalformedBadgeMint');
    if (data.subarray(82, BASE_ACCOUNT_LEN).some(b => b !== 0)) throw new Error('MalformedBadgeMint');
    if (data[45] !== 1) throw new Error('MalformedBadgeMint');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const member = findExtension(data, EXT_TOKEN_GROUP_MEMBER);
    return {
        mintAuthority: view.getUint32(0, true) === 1 ? bytesToAddress(data.subarray(4, 36)) : null,
        supply: view.getBigUint64(36, true),
        decimals: data[44],
        nonTransferable: findExtension(data, EXT_NON_TRANSFERABLE) !== null,
        groupMember:
            member && member.length >= 72
                ? { mint: bytesToAddress(member.subarray(0, 32)), group: bytesToAddress(member.subarray(32, 64)) }
                : null,
    };
}

export function parseTokenAccount(data: Uint8Array): BadgeTokenAccount {
    if (data.length < BASE_ACCOUNT_LEN) throw new Error('MalformedBadgeTokenAccount');
    if (data.length > BASE_ACCOUNT_LEN && data[BASE_ACCOUNT_LEN] !== 2) throw new Error('MalformedBadgeTokenAccount');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
        mint: bytesToAddress(data.subarray(0, 32)),
        owner: bytesToAddress(data.subarray(32, 64)),
        amount: view.getBigUint64(64, true),
        state: data[108],
    };
}
