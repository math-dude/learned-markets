import {
    AccountRole,
    addCodecSizePrefix,
    fixCodecSize,
    getAddressCodec,
    getArrayCodec,
    getBooleanCodec,
    getBytesCodec,
    getI64Codec,
    getNullableCodec,
    getProgramDerivedAddress,
    getStructCodec,
    getU32Codec,
    getU64Codec,
    getU8Codec,
    getUtf8Codec,
    address,
    type AccountMeta,
    type AccountSignerMeta,
    type Address,
    type Instruction,
    type TransactionSigner,
} from '@solana/kit';
import { addressBytes, concat } from './bytes.ts';
import { APP_SCOPE, LEARNED_MARKETS_PROGRAM_ADDRESS, VERIFICATION_METHOD_OPERATOR_APPROVED } from './constants.ts';
import {
    findConfigPda,
    findIntentPda,
    findParticipantPda,
    findWalletBindingPda,
    instructionDiscriminator,
} from './gate-accounts.ts';
import type { IntentKind } from './intent-payload.ts';

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');

type Acct = Address | TransactionSigner;
type Meta = AccountMeta | AccountSignerMeta;

const addr = (a: Acct): Address => (typeof a === 'string' ? a : a.address);

function meta(a: Acct, writable: boolean, signer = false): Meta {
    const role = signer
        ? writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
        : writable ? AccountRole.WRITABLE : AccountRole.READONLY;
    if (signer && typeof a !== 'string') return { address: a.address, role, signer: a };
    return { address: addr(a), role };
}

export type GateInstruction = Instruction & { accounts: Meta[]; data: Uint8Array };

function ix(name: string, accounts: Meta[], args: Uint8Array = new Uint8Array()): GateInstruction {
    return {
        programAddress: LEARNED_MARKETS_PROGRAM_ADDRESS,
        accounts,
        data: concat(instructionDiscriminator(name), args),
    };
}

/** SAS + badge accounts in the order every gated instruction expects. */
export type BadgeAccountAddresses = {
    credential: Address;
    schema: Address;
    schemaMint: Address;
    attestation: Address;
    badgeMint: Address;
    badgeTokenAccount: Address;
};

const badgeMetas = (b: BadgeAccountAddresses): Meta[] => [
    meta(b.credential, false),
    meta(b.schema, false),
    meta(b.schemaMint, false),
    meta(b.attestation, false),
    meta(b.badgeMint, false),
    meta(b.badgeTokenAccount, false),
];

const str = () => addCodecSizePrefix(getUtf8Codec(), getU32Codec());

export const initializeConfigArgsCodec = getStructCodec([
    ['appScope', str()],
    ['network', str()],
    ['admin', getAddressCodec()],
    ['settlementAuthority', getAddressCodec()],
    ['credentialAuthority', getAddressCodec()],
    ['schemaVersion', getU8Codec()],
    ['allowedVerificationMethod', getU8Codec()],
]);

export async function initializeConfigInstruction(p: {
    payer: Acct;
    deploymentAuthority: Acct;
    credential: Address;
    schema: Address;
    network: string;
    admin: Address;
    settlementAuthority: Address;
    credentialAuthority: Address;
    programAddress?: Address;
}): Promise<GateInstruction> {
    const program = p.programAddress ?? LEARNED_MARKETS_PROGRAM_ADDRESS;
    const [programData] = await getProgramDerivedAddress({ programAddress: UPGRADEABLE_LOADER, seeds: [addressBytes(program)] });
    const args = initializeConfigArgsCodec.encode({
        appScope: APP_SCOPE,
        network: p.network,
        admin: p.admin,
        settlementAuthority: p.settlementAuthority,
        credentialAuthority: p.credentialAuthority,
        schemaVersion: 1,
        allowedVerificationMethod: VERIFICATION_METHOD_OPERATOR_APPROVED,
    });
    return ix(
        'initialize_config',
        [
            meta(p.payer, true, true),
            meta(p.deploymentAuthority, false, true),
            meta(program, false),
            meta(programData, false),
            meta(await findConfigPda(), true),
            meta(p.credential, false),
            meta(p.schema, false),
            meta(SYSTEM_PROGRAM, false),
        ],
        new Uint8Array(args),
    );
}

const updateConfigArgsCodec = getStructCodec([
    ['admissionPaused', getNullableCodec(getBooleanCodec())],
    ['admin', getNullableCodec(getAddressCodec())],
    ['settlementAuthority', getNullableCodec(getAddressCodec())],
]);

export async function updateConfigInstruction(p: {
    admin: Acct;
    admissionPaused?: boolean | null;
    newAdmin?: Address | null;
    settlementAuthority?: Address | null;
}): Promise<GateInstruction> {
    const args = updateConfigArgsCodec.encode({
        admissionPaused: p.admissionPaused ?? null,
        admin: p.newAdmin ?? null,
        settlementAuthority: p.settlementAuthority ?? null,
    });
    return ix('update_config', [meta(p.admin, false, true), meta(await findConfigPda(), true)], new Uint8Array(args));
}

export async function registerParticipantInstruction(p: {
    payer: Acct;
    wallet: Acct;
    participantId: Uint8Array;
    badge: BadgeAccountAddresses;
}): Promise<GateInstruction> {
    return ix(
        'register_participant',
        [
            meta(p.payer, true, true),
            meta(p.wallet, false, true),
            meta(await findConfigPda(), false),
            meta(await findParticipantPda(p.participantId), true),
            meta(await findWalletBindingPda(addr(p.wallet)), true),
            ...badgeMetas(p.badge),
            meta(SYSTEM_PROGRAM, false),
        ],
        p.participantId,
    );
}

async function statusInstruction(name: string, admin: Acct, participantId: Uint8Array) {
    return ix(name, [
        meta(admin, false, true),
        meta(await findConfigPda(), false),
        meta(await findParticipantPda(participantId), true),
    ]);
}

export const suspendParticipantInstruction = (p: { admin: Acct; participantId: Uint8Array }) =>
    statusInstruction('suspend_participant', p.admin, p.participantId);
export const revokeParticipantInstruction = (p: { admin: Acct; participantId: Uint8Array }) =>
    statusInstruction('revoke_participant', p.admin, p.participantId);

/** Wallet replacement (oldWallet set) or same-wallet renewal (oldWallet omitted). */
export async function replaceBindingInstruction(p: {
    payer: Acct;
    admin: Acct;
    newWallet: Acct;
    oldWallet?: Address | null;
    participantId: Uint8Array;
    badge: BadgeAccountAddresses;
}): Promise<GateInstruction> {
    const newWallet = addr(p.newWallet);
    const sameWallet = !p.oldWallet || p.oldWallet === newWallet;
    return ix('replace_binding', [
        meta(p.payer, true, true),
        meta(p.admin, false, true),
        meta(p.newWallet, false, true),
        meta(await findConfigPda(), false),
        meta(await findParticipantPda(p.participantId), true),
        // Anchor encodes an omitted Option<Account> as the program id.
        sameWallet
            ? meta(LEARNED_MARKETS_PROGRAM_ADDRESS, false)
            : meta(await findWalletBindingPda(p.oldWallet as Address), true),
        meta(await findWalletBindingPda(newWallet), true),
        ...badgeMetas(p.badge),
        meta(SYSTEM_PROGRAM, false),
    ]);
}

export const submitIntentArgsCodec = getStructCodec([
    ['nonce', getU64Codec()],
    ['kind', getU8Codec()],
    ['target', getAddressCodec()],
    ['payloadHash', fixCodecSize(getBytesCodec(), 32)],
    ['deadline', getI64Codec()],
]);

export async function submitIntentInstruction(p: {
    wallet: Acct;
    participantId: Uint8Array;
    badge: BadgeAccountAddresses;
    nonce: bigint;
    kind: IntentKind;
    target: Address;
    payloadHash: Uint8Array;
    deadline: bigint;
}): Promise<GateInstruction & { intent: Address }> {
    const participant = await findParticipantPda(p.participantId);
    const intent = await findIntentPda(participant, p.nonce);
    const args = submitIntentArgsCodec.encode({
        nonce: p.nonce,
        kind: p.kind,
        target: p.target,
        payloadHash: p.payloadHash,
        deadline: p.deadline,
    });
    const built = ix(
        'submit_intent',
        [
            meta(p.wallet, true, true),
            meta(await findConfigPda(), false),
            meta(participant, true),
            meta(await findWalletBindingPda(addr(p.wallet)), false),
            ...badgeMetas(p.badge),
            meta(intent, true),
            meta(SYSTEM_PROGRAM, false),
        ],
        new Uint8Array(args),
    );
    return { ...built, intent };
}

export async function cancelIntentInstruction(p: { wallet: Acct; participantId: Uint8Array; nonce: bigint }) {
    const participant = await findParticipantPda(p.participantId);
    return ix('cancel_intent', [
        meta(p.wallet, false, true),
        meta(await findConfigPda(), false),
        meta(participant, false),
        meta(await findIntentPda(participant, p.nonce), true),
    ]);
}

export const settlementRequestCodec = getStructCodec([
    ['version', getU8Codec()],
    ['market', getAddressCodec()],
    ['batchId', getU64Codec()],
    [
        'intents',
        getArrayCodec(
            getStructCodec([
                ['intent', getAddressCodec()],
                ['contents', addCodecSizePrefix(getBytesCodec(), getU32Codec())],
            ]),
        ),
    ],
]);

export type SettlementItem = {
    intent: Address;
    contents: Uint8Array;
    participant: Address;
    walletBinding: Address;
    attestation: Address;
    badgeMint: Address;
    badgeTokenAccount: Address;
};

/** Reserved entrypoint; the program currently returns SettlementNotImplemented. */
export async function settleBatchInstruction(p: {
    settlementAuthority: Acct;
    credential: Address;
    schema: Address;
    schemaMint: Address;
    market: Address;
    batchId: bigint;
    items: SettlementItem[];
}): Promise<GateInstruction> {
    const data = settlementRequestCodec.encode({
        version: 1,
        market: p.market,
        batchId: p.batchId,
        intents: p.items.map(i => ({ intent: i.intent, contents: i.contents })),
    });
    return ix(
        'settle_batch',
        [
            meta(p.settlementAuthority, false, true),
            meta(await findConfigPda(), false),
            meta(p.credential, false),
            meta(p.schema, false),
            meta(p.schemaMint, false),
            ...p.items.flatMap(i => [
                meta(i.intent, true),
                meta(i.participant, false),
                meta(i.walletBinding, false),
                meta(i.attestation, false),
                meta(i.badgeMint, false),
                meta(i.badgeTokenAccount, false),
            ]),
        ],
        new Uint8Array(data),
    );
}
