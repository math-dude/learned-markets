/**
 * Operator operations (issuer setup, issuance, revocation, registry admin).
 * Signing keys are only ever loaded by operator tooling — never by the HTTP service.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
    createKeyPairSignerFromBytes,
    createSolanaRpc,
    generateKeyPair,
    getAddressFromPublicKey,
    type Address,
    type KeyPairSigner,
    type Rpc,
    type SolanaRpcApi,
} from '@solana/kit';
import { APP_SCOPE, DEFAULT_ATTESTATION_LIFETIME_SECS, VERIFICATION_METHOD_OPERATOR_APPROVED } from './constants.ts';
import { createBadgeInstruction, createIssuerInstructions, issuerAddresses, revokeBadgeInstruction, setSchemaPausedInstruction, type IssuerAddresses } from './sas.ts';
import { sendAndConfirm, type SubmittedTx } from './tx.ts';
import {
    initializeConfigInstruction,
    revokeParticipantInstruction,
    suspendParticipantInstruction,
    updateConfigInstruction,
} from './gate-instructions.ts';
import { getSysvarClockDecoder, SYSVAR_CLOCK_ADDRESS } from '@solana/sysvars';
import { getBase64Encoder } from '@solana/kit';

export async function loadSigner(path: string): Promise<KeyPairSigner> {
    const bytes = Uint8Array.from(JSON.parse(await readFile(path, 'utf8')) as number[]);
    return createKeyPairSignerFromBytes(bytes);
}

/** Writes a solana-keygen compatible keypair file (mode 0600). */
export async function generateKeypairFile(path: string): Promise<Address> {
    const kp = await generateKeyPair(true);
    const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).slice(-32);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify([...priv, ...pub]), { mode: 0o600, flag: 'wx' });
    return getAddressFromPublicKey(kp.publicKey);
}

export type OperatorKeys = {
    payer: KeyPairSigner;
    credentialAuthority?: KeyPairSigner;
    issuanceSigner?: KeyPairSigner;
    admin?: KeyPairSigner;
    deployer?: KeyPairSigner;
};

export function rpcFor(url: string): Rpc<SolanaRpcApi> {
    return createSolanaRpc(url);
}

export async function chainNow(rpc: Rpc<SolanaRpcApi>): Promise<bigint> {
    const { value } = await rpc.getAccountInfo(SYSVAR_CLOCK_ADDRESS, { encoding: 'base64', commitment: 'confirmed' }).send();
    if (!value) throw new Error('clock sysvar unavailable');
    return getSysvarClockDecoder().decode(getBase64Encoder().encode(value.data[0])).unixTimestamp;
}

async function exists(rpc: Rpc<SolanaRpcApi>, a: Address): Promise<boolean> {
    const { value } = await rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send();
    return value !== null;
}

/** Idempotent issuer setup: credential, schema v1, schema group (capacity 1,000,000). */
export async function setupIssuer(rpc: Rpc<SolanaRpcApi>, keys: { payer: KeyPairSigner; credentialAuthority: KeyPairSigner; issuanceSigner: Address }) {
    const issuer = await issuerAddresses(keys.credentialAuthority.address);
    const [cred, schema, mint] = createIssuerInstructions({ payer: keys.payer, credentialAuthority: keys.credentialAuthority, issuanceSigner: keys.issuanceSigner, issuer });
    const steps: { name: string; address: Address; ix: typeof cred }[] = [
        { name: 'credential', address: issuer.credential, ix: cred },
        { name: 'schema', address: issuer.schema, ix: schema },
        { name: 'schemaMint', address: issuer.schemaMint, ix: mint },
    ];
    const signatures: Record<string, string> = {};
    for (const s of steps) {
        if (await exists(rpc, s.address)) continue;
        const tx = await sendAndConfirm({ rpc, feePayer: keys.payer, instructions: [s.ix] });
        signatures[s.name] = tx.signature;
    }
    return { issuer, signatures };
}

export async function initializeGate(
    rpc: Rpc<SolanaRpcApi>,
    p: { payer: KeyPairSigner; deployer: KeyPairSigner; issuer: IssuerAddresses; credentialAuthority: Address; admin: Address; settlementAuthority: Address; network: string },
) {
    const ix = await initializeConfigInstruction({
        payer: p.payer,
        deploymentAuthority: p.deployer,
        credential: p.issuer.credential,
        schema: p.issuer.schema,
        network: p.network,
        admin: p.admin,
        settlementAuthority: p.settlementAuthority,
        credentialAuthority: p.credentialAuthority,
    });
    return sendAndConfirm({ rpc, feePayer: p.payer, instructions: [ix] });
}

export type IssueParams = {
    participantId: Uint8Array;
    wallet: Address;
    bindingVersion: number;
    uri: string;
    lifetimeSecs?: number;
    beforeSend?: (tx: SubmittedTx) => void | Promise<void>;
};

export async function issueBadge(rpc: Rpc<SolanaRpcApi>, keys: { payer: KeyPairSigner; issuanceSigner: KeyPairSigner }, issuer: IssuerAddresses, p: IssueParams) {
    const lifetime = p.lifetimeSecs ?? DEFAULT_ATTESTATION_LIFETIME_SECS;
    if (lifetime <= 0 || lifetime > DEFAULT_ATTESTATION_LIFETIME_SECS) throw new Error('lifetime must be within (0, 7 days]');
    const now = await chainNow(rpc);
    const built = await createBadgeInstruction({
        payer: keys.payer,
        issuanceSigner: keys.issuanceSigner,
        issuer,
        data: {
            appScope: APP_SCOPE,
            participantId: p.participantId,
            wallet: p.wallet,
            verificationMethod: VERIFICATION_METHOD_OPERATOR_APPROVED,
            bindingVersion: p.bindingVersion,
            issuedAt: now,
        },
        expiry: now + BigInt(lifetime),
        uri: p.uri,
    });
    const tx = await sendAndConfirm({ rpc, feePayer: keys.payer, instructions: [built.instruction], beforeSend: p.beforeSend });
    return { ...tx, ...built.addresses, mintAccountSpace: built.mintAccountSpace, expiry: now + BigInt(lifetime) };
}

export async function revokeBadge(
    rpc: Rpc<SolanaRpcApi>,
    keys: { payer: KeyPairSigner; issuanceSigner: KeyPairSigner },
    issuer: IssuerAddresses,
    p: { attestation: Address; badgeTokenAccount: Address; beforeSend?: (tx: SubmittedTx) => void | Promise<void> },
) {
    const ix = await revokeBadgeInstruction({ payer: keys.payer, issuanceSigner: keys.issuanceSigner, issuer, ...p });
    return sendAndConfirm({ rpc, feePayer: keys.payer, instructions: [ix], beforeSend: p.beforeSend });
}

export async function setSchemaPaused(rpc: Rpc<SolanaRpcApi>, keys: { payer: KeyPairSigner; credentialAuthority: KeyPairSigner }, issuer: IssuerAddresses, paused: boolean) {
    const ix = setSchemaPausedInstruction({ credentialAuthority: keys.credentialAuthority, issuer, paused });
    return sendAndConfirm({ rpc, feePayer: keys.payer, instructions: [ix] });
}

export async function suspendParticipant(rpc: Rpc<SolanaRpcApi>, keys: { payer: KeyPairSigner; admin: KeyPairSigner }, participantId: Uint8Array, beforeSend?: (tx: SubmittedTx) => void | Promise<void>) {
    const ix = await suspendParticipantInstruction({ admin: keys.admin, participantId });
    return sendAndConfirm({ rpc, feePayer: keys.payer, instructions: [ix], beforeSend });
}

export async function revokeParticipant(rpc: Rpc<SolanaRpcApi>, keys: { payer: KeyPairSigner; admin: KeyPairSigner }, participantId: Uint8Array) {
    const ix = await revokeParticipantInstruction({ admin: keys.admin, participantId });
    return sendAndConfirm({ rpc, feePayer: keys.payer, instructions: [ix] });
}

export async function setAdmissionPaused(rpc: Rpc<SolanaRpcApi>, keys: { payer: KeyPairSigner; admin: KeyPairSigner }, paused: boolean) {
    const ix = await updateConfigInstruction({ admin: keys.admin, admissionPaused: paused });
    return sendAndConfirm({ rpc, feePayer: keys.payer, instructions: [ix] });
}
