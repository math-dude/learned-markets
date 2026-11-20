import {
    address,
    appendTransactionMessageInstructions,
    compileTransaction,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase58Decoder,
    getBase64EncodedWireTransaction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    signBytes,
    type Address,
    type Blockhash,
    type Instruction,
    type KeyPairSigner,
} from '@solana/kit';
import {
    APP_SCOPE,
    badgeAddresses,
    ConfirmationTimeoutError,
    findParticipantPda,
    fromHex,
    ParticipantStatus,
    RpcUnavailableError,
    toHex,
    type EligibilityReport,
    type GateConfig,
    type IntentAccount,
    type SignatureOutcome,
    type SubmittedTx,
} from '@learned-markets/attestations';
import { createApp } from '../src/app.ts';
import type { Chain, ParticipantRecord } from '../src/chain.ts';
import type { ServiceConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import type { OperatorExecutor } from '../src/operations.ts';

export const ORIGIN = 'https://lm.example';
const A = (b: number) => getBase58Decoder().decode(new Uint8Array(32).fill(b)) as Address;

export const CONFIG: GateConfig = {
    version: 1, bump: 255, appScope: APP_SCOPE, network: 'devnet',
    admin: A(1), settlementAuthority: A(2), sasProgram: address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG'), sasAuthority: A(3),
    credential: A(4), credentialAuthority: A(5), schema: A(6), schemaVersion: 1, schemaMint: A(7),
    allowedVerificationMethod: 0, admissionPaused: false,
};

/** In-memory stand-in for the chain, with failure injection. */
export class FakeChain implements Chain {
    async genesisHash() { return "local-test-genesis"; }
    participants = new Map<string, ParticipantRecord>();
    attestations = new Set<string>();
    bindings = new Set<string>();
    intents = new Map<string, IntentAccount & { slot: bigint }>();
    badgeExpiry = 2_000_000_000n;
    clock = 1_800_000_000n;
    slot = 100n;
    rpcDown = false;

    private check() {
        if (this.rpcDown) throw new RpcUnavailableError(new Error('connect ECONNREFUSED'));
    }
    async eligibility(wallet: Address): Promise<EligibilityReport> {
        this.check();
        const p = [...this.participants.values()].find(x => x.currentWallet === wallet);
        if (!p) return { wallet, attestationValid: false, registryActive: false, eligible: false, reasons: [{ code: 'NotRegistered', message: '' }], slot: `${this.slot}`, participant: null, badge: null };
        const registryActive = p.status === ParticipantStatus.Active;
        const attestationValid = this.attestations.has(p.currentAttestation) && this.clock < this.badgeExpiry;
        const reasons = [
            ...(registryActive ? [] : [{ code: p.status === ParticipantStatus.Revoked ? 'ParticipantRevoked' : 'ParticipantNotActive', message: '' }]),
            ...(attestationValid ? [] : [{ code: 'AttestationExpired', message: '' }]),
        ];
        return {
            wallet, attestationValid, registryActive, eligible: registryActive && attestationValid, reasons, slot: `${this.slot}`,
            participant: {
                address: p.address, participantIdHex: toHex(p.participantId), currentWallet: p.currentWallet, bindingVersion: p.bindingVersion,
                status: (['Active', 'Suspended', 'Revoked'] as const)[p.status], nextIntentNonce: p.nextIntentNonce.toString(),
            },
            badge: { attestation: p.currentAttestation, badgeMint: p.currentBadgeMint, expiry: this.badgeExpiry.toString() },
        };
    }
    async inspectAttestation(a: Address) {
        this.check();
        return { attestation: a, attestationValid: this.attestations.has(a) };
    }
    async config() {
        this.check();
        return CONFIG;
    }
    async participantById(id: Uint8Array) {
        this.check();
        return this.participants.get(toHex(id)) ?? null;
    }
    async intent(a: Address) {
        this.check();
        return this.intents.get(a) ?? null;
    }
    async accountExists(a: Address) {
        this.check();
        return this.attestations.has(a) || this.bindings.has(a);
    }
    async now() {
        this.check();
        return this.clock;
    }
    async buildWalletTransaction(feePayer: Address, instructions: Instruction[]) {
        this.check();
        const msg = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayer(feePayer, m),
            m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: A(9) as unknown as Blockhash, lastValidBlockHeight: 1000n }, m),
            m => appendTransactionMessageInstructions(instructions, m),
        );
        return { transactionBase64: getBase64EncodedWireTransaction(compileTransaction(msg)), lastValidBlockHeight: 1000n };
    }
    async listParticipants() {
        return { slot: this.slot, participants: [...this.participants.values()] };
    }

    /** Simulates a confirmed register_participant / replace_binding. */
    async bind(participantIdHex: string, wallet: Address, attestation: Address, bindingVersion: number) {
        const id = fromHex(participantIdHex);
        const prev = this.participants.get(participantIdHex);
        this.participants.set(participantIdHex, {
            version: 1, bump: 255, participantId: id, currentWallet: wallet, currentAttestation: attestation, currentBadgeMint: A(8),
            bindingVersion, status: ParticipantStatus.Active, nextIntentNonce: prev?.nextIntentNonce ?? 0n, registeredAt: 0n, updatedAt: 0n,
            address: await findParticipantPda(id),
        });
    }
}

type Call = { kind: string; args: unknown };

/** Fake operator executor with scripted failures, applying effects to FakeChain. */
export class FakeExecutor implements OperatorExecutor {
    calls: Call[] = [];
    outcomes = new Map<string, SignatureOutcome>();
    /** Per-kind failure script: 'timeout' | 'crash-after-send' | 'reject' */
    fail = new Map<string, 'timeout' | 'crash-after-send' | 'reject'>();
    private n = 0;
    private chain: FakeChain;
    constructor(chain: FakeChain) {
        this.chain = chain;
    }

    private async run(kind: string, args: unknown, beforeSend: (tx: SubmittedTx) => void, effect: () => void | Promise<void>, landsOnTimeout = true) {
        this.calls.push({ kind, args });
        const mode = this.fail.get(kind);
        this.fail.delete(kind);
        if (mode === 'reject') throw new Error(`${kind} rejected in preflight`);
        const tx = { signature: `sig${++this.n}${kind}` as never, lastValidBlockHeight: 50n };
        beforeSend(tx);
        if (mode === 'timeout') {
            if (landsOnTimeout) await effect();
            throw new ConfirmationTimeoutError(tx);
        }
        await effect();
        if (mode === 'crash-after-send') throw new Error('process crashed');
        this.outcomes.set(tx.signature, 'confirmed');
        return tx;
    }
    count(kind: string) {
        return this.calls.filter(c => c.kind === kind).length;
    }
    suspend(pid: Uint8Array, b: (tx: SubmittedTx) => void) {
        return this.run('suspend', toHex(pid), b, () => {
            const p = this.chain.participants.get(toHex(pid))!;
            p.status = ParticipantStatus.Suspended;
        });
    }
    revokeBadge(attestation: Address, _t: Address, b: (tx: SubmittedTx) => void) {
        return this.run('revoke', attestation, b, () => void this.chain.attestations.delete(attestation));
    }
    lostIssuance = false;
    issueBadge(p: { participantId: Uint8Array; wallet: Address; bindingVersion: number }, b: (tx: SubmittedTx) => void) {
        return this.run('issue', p, b, async () => {
            this.issued.push(p);
            const issuer = { credential: CONFIG.credential, schema: CONFIG.schema, schemaMint: CONFIG.schemaMint, sasAuthority: CONFIG.sasAuthority };
            this.chain.attestations.add((await badgeAddresses(issuer, p.participantId, p.bindingVersion, p.wallet)).attestation);
        }, !this.lostIssuance);
    }
    issued: { participantId: Uint8Array; wallet: Address; bindingVersion: number }[] = [];
    onCosign: (() => Promise<void>) | null = null;
    cosignAndSubmit(signed: string, b: (tx: SubmittedTx) => void) {
        return this.run('cosign', signed.length, b, async () => this.onCosign?.());
    }
    async reconcile(tx: SubmittedTx) {
        return this.outcomes.get(tx.signature) ?? 'pending';
    }
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function harness() {
    const db: Db = openDb(':memory:');
    const chain = new FakeChain();
    let clock = 1_700_000_000_000;
    const config: ServiceConfig = {
        origin: ORIGIN, badgeOrigin: 'https://badges.lm.example', port: 0, dbPath: ':memory:', rpcUrl: '', network: 'devnet',
        operatorPayer: A(11), secureCookies: true,
    };
    const app = createApp({ db, chain, config, now: () => clock });
    const req = async (method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string } = {}) => {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (opts.cookie) headers.cookie = opts.cookie;
        if (opts.origin) headers.origin = opts.origin;
        const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
    };
    const signChallenge = async (signer: KeyPairSigner, action: string, replacesWallet?: Address, by: KeyPairSigner = signer) => {
        const ch = await req('POST', '/v1/challenges', { body: { wallet: signer.address, action, replacesWallet } });
        const sig = await signBytes(by.keyPair.privateKey, new TextEncoder().encode(ch.json.message));
        return { challengeId: ch.json.challengeId as string, message: ch.json.message as string, signature: getBase58Decoder().decode(sig) };
    };
    const login = async (signer: KeyPairSigner) => {
        const s = await signChallenge(signer, 'session');
        const res = await req('POST', '/v1/sessions', { body: s });
        const cookie = res.headers.get('set-cookie')?.split(';')[0];
        return { res, cookie };
    };
    return {
        db, chain, app, config, req, signChallenge, login,
        advance: (ms: number) => void (clock += ms),
        wallet: () => generateKeyPairSigner(),
    };
}
