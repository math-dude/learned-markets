import {
    addCodecSizePrefix,
    fixCodecSize,
    getAddressCodec,
    getBooleanCodec,
    getBytesCodec,
    getI64Codec,
    getProgramDerivedAddress,
    getStructCodec,
    getU32Codec,
    getU64Codec,
    getU8Codec,
    getUtf8Codec,
    type Address,
    type Codec,
} from '@solana/kit';
import { APP_SCOPE, LEARNED_MARKETS_PROGRAM_ADDRESS } from './constants.ts';
import { addressBytes, bytesEqual, sha256, u64le, utf8 } from './bytes.ts';

/** Anchor account discriminator: sha256("account:<Name>")[0..8]. */
export function accountDiscriminator(name: string): Uint8Array {
    return sha256(utf8.encode(`account:${name}`)).subarray(0, 8);
}

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export function instructionDiscriminator(name: string): Uint8Array {
    return sha256(utf8.encode(`global:${name}`)).subarray(0, 8);
}

const str = () => addCodecSizePrefix(getUtf8Codec(), getU32Codec());
const bytes32 = () => fixCodecSize(getBytesCodec(), 32);

export const ParticipantStatus = { Active: 0, Suspended: 1, Revoked: 2 } as const;
export const ParticipantStatusName = ['Active', 'Suspended', 'Revoked'] as const;
export const IntentState = { Open: 0, Cancelled: 1, Consumed: 2 } as const;
export const IntentStateName = ['Open', 'Cancelled', 'Consumed'] as const;

export type GateConfig = {
    version: number;
    bump: number;
    appScope: string;
    network: string;
    admin: Address;
    settlementAuthority: Address;
    sasProgram: Address;
    sasAuthority: Address;
    credential: Address;
    credentialAuthority: Address;
    schema: Address;
    schemaVersion: number;
    schemaMint: Address;
    allowedVerificationMethod: number;
    admissionPaused: boolean;
};

export type ParticipantAccount = {
    version: number;
    bump: number;
    participantId: Uint8Array;
    currentWallet: Address;
    currentAttestation: Address;
    currentBadgeMint: Address;
    bindingVersion: number;
    status: number;
    nextIntentNonce: bigint;
    registeredAt: bigint;
    updatedAt: bigint;
};

export type WalletBindingAccount = {
    version: number;
    bump: number;
    wallet: Address;
    participant: Address;
    participantId: Uint8Array;
    active: boolean;
    boundAt: bigint;
    retiredAt: bigint;
};

export type IntentAccount = {
    version: number;
    bump: number;
    participant: Address;
    wallet: Address;
    bindingVersion: number;
    nonce: bigint;
    kind: number;
    target: Address;
    payloadHash: Uint8Array;
    createdAt: bigint;
    deadline: bigint;
    state: number;
};

export const configCodec = getStructCodec([
    ['version', getU8Codec()],
    ['bump', getU8Codec()],
    ['appScope', str()],
    ['network', str()],
    ['admin', getAddressCodec()],
    ['settlementAuthority', getAddressCodec()],
    ['sasProgram', getAddressCodec()],
    ['sasAuthority', getAddressCodec()],
    ['credential', getAddressCodec()],
    ['credentialAuthority', getAddressCodec()],
    ['schema', getAddressCodec()],
    ['schemaVersion', getU8Codec()],
    ['schemaMint', getAddressCodec()],
    ['allowedVerificationMethod', getU8Codec()],
    ['admissionPaused', getBooleanCodec()],
]) as unknown as Codec<GateConfig>;

export const participantCodec = getStructCodec([
    ['version', getU8Codec()],
    ['bump', getU8Codec()],
    ['participantId', bytes32()],
    ['currentWallet', getAddressCodec()],
    ['currentAttestation', getAddressCodec()],
    ['currentBadgeMint', getAddressCodec()],
    ['bindingVersion', getU32Codec()],
    ['status', getU8Codec()],
    ['nextIntentNonce', getU64Codec()],
    ['registeredAt', getI64Codec()],
    ['updatedAt', getI64Codec()],
]) as unknown as Codec<ParticipantAccount>;

export const walletBindingCodec = getStructCodec([
    ['version', getU8Codec()],
    ['bump', getU8Codec()],
    ['wallet', getAddressCodec()],
    ['participant', getAddressCodec()],
    ['participantId', bytes32()],
    ['active', getBooleanCodec()],
    ['boundAt', getI64Codec()],
    ['retiredAt', getI64Codec()],
]) as unknown as Codec<WalletBindingAccount>;

export const intentCodec = getStructCodec([
    ['version', getU8Codec()],
    ['bump', getU8Codec()],
    ['participant', getAddressCodec()],
    ['wallet', getAddressCodec()],
    ['bindingVersion', getU32Codec()],
    ['nonce', getU64Codec()],
    ['kind', getU8Codec()],
    ['target', getAddressCodec()],
    ['payloadHash', bytes32()],
    ['createdAt', getI64Codec()],
    ['deadline', getI64Codec()],
    ['state', getU8Codec()],
]) as unknown as Codec<IntentAccount>;

function decodeAnchor<T>(name: string, codec: Codec<T>, data: Uint8Array): T {
    if (data.length < 8 || !bytesEqual(data.subarray(0, 8), accountDiscriminator(name)))
        throw new Error(`not a ${name} account`);
    const v = codec.decode(data.subarray(8)) as T & Record<string, unknown>;
    for (const [k, val] of Object.entries(v)) if (val instanceof Uint8Array) (v as Record<string, unknown>)[k] = new Uint8Array(val);
    return v;
}

export const decodeConfig = (d: Uint8Array) => decodeAnchor('Config', configCodec, d);
export const decodeParticipant = (d: Uint8Array) => decodeAnchor('Participant', participantCodec, d);
export const decodeWalletBinding = (d: Uint8Array) => decodeAnchor('WalletBinding', walletBindingCodec, d);
export const decodeIntent = (d: Uint8Array) => decodeAnchor('Intent', intentCodec, d);

const pda = async (seeds: Uint8Array[], programAddress: Address = LEARNED_MARKETS_PROGRAM_ADDRESS) =>
    (await getProgramDerivedAddress({ programAddress, seeds }))[0];

export const findConfigPda = (program?: Address) => pda([utf8.encode('config')], program);
export const findParticipantPda = (participantId: Uint8Array, program?: Address) =>
    pda([utf8.encode('participant'), utf8.encode(APP_SCOPE), participantId], program);
export const findWalletBindingPda = (wallet: Address, program?: Address) =>
    pda([utf8.encode('wallet-binding'), addressBytes(wallet)], program);
export const findIntentPda = (participant: Address, nonce: bigint, program?: Address) =>
    pda([utf8.encode('intent'), addressBytes(participant), u64le(nonce)], program);
