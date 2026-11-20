/**
 * Two-user, client-only gated admission demo against a running attestation service.
 *
 * The participants behave like browser wallets: they hold only their own key, talk to the
 * service over HTTP, sign the challenge messages and the transactions the service prepares,
 * and send those to the RPC themselves. They never build program instructions. The operator
 * approves and issues badges in a separate process (operator-cli), the only place keys load.
 *
 *   # terminal 1
 *   DB_PATH=attestation-service.devnet.sqlite LM_RPC_URL=https://api.devnet.solana.com node apps/attestation-service/src/main.ts
 *   # terminal 2
 *   DB_PATH=attestation-service.devnet.sqlite LM_RPC_URL=https://api.devnet.solana.com node scripts/two-user-client-demo.ts
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    getBase58Decoder,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
    lamports,
    signBytes,
    signTransaction,
    type Address,
    type KeyPairSigner,
    type Transaction,
} from '@solana/kit';
import { generateKeypairFile, loadSigner, rpcFor, sendAndConfirm } from '@learned-markets/attestations';

const run = promisify(execFile);
const serviceUrl = process.env.SERVICE_URL ?? 'http://localhost:8787';
const origin = new URL(serviceUrl).origin;
const rpcUrl = process.env.LM_RPC_URL ?? 'https://api.devnet.solana.com';
const network = process.env.LM_NETWORK ?? 'devnet';
const rpc = rpcFor(rpcUrl);
const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const record: { runId: string; network: string; serviceUrl: string; users: Record<string, unknown>; checks: unknown[] } = {
    runId, network, serviceUrl, users: {}, checks: [],
};
const log = (...a: unknown[]) => console.log(...a);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Public devnet RPC rate-limits; the service fails closed (503) and the client retries the whole step. */
async function retrying<T>(label: string, f: () => Promise<T>, tries = 8): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return await f();
        } catch (e) {
            const msg = (e as Error).message;
            const transient = /-> 503|RpcUnavailable|429|Too Many|fetch failed|error sending request|ECONNRESET/.test(msg);
            if (!transient || i >= tries) throw e;
            log(`  (${label}: transient RPC failure, retrying)`);
            await sleep(2000 * 2 ** Math.min(i, 3));
        }
    }
}

// ------------------------------------------------------------------ operator (separate process)

async function operator(...args: string[]) {
    const { stdout } = await run('node', ['apps/attestation-service/src/operator-cli.ts', ...args], { env: process.env, maxBuffer: 1 << 22 });
    return JSON.parse(stdout);
}

// ------------------------------------------------------------------ browser-wallet side

export class Client {
    name: string;
    wallet: KeyPairSigner;
    cookie: string | undefined;
    constructor(name: string, wallet: KeyPairSigner) {
        this.name = name;
        this.wallet = wallet;
    }
    async http(method: string, path: string, body?: unknown) {
        const headers: Record<string, string> = { 'content-type': 'application/json', origin };
        if (this.cookie) headers.cookie = this.cookie;
        const res = await fetch(serviceUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) this.cookie = setCookie.split(';')[0];
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : null };
    }
    async ok(method: string, path: string, body?: unknown) {
        const r = await this.http(method, path, body);
        if (r.status >= 300) throw new Error(`${this.name} ${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
        return r.json;
    }
    /** Wallet "signMessage": signs the exact challenge text the service returned. */
    async signedChallenge(action: string) {
        const ch = await this.ok('POST', '/v1/challenges', { wallet: this.wallet.address, action });
        const sig = await signBytes(this.wallet.keyPair.privateKey, new TextEncoder().encode(ch.message));
        return { challengeId: ch.challengeId as string, signature: getBase58Decoder().decode(sig), message: ch.message as string };
    }
    /** Wallet "signAndSendTransaction": signs the service-prepared transaction and submits it to the RPC. */
    async signAndSend(transactionBase64: string) {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64)) as Transaction;
        const signed = await signTransaction([this.wallet.keyPair], tx);
        const signature = getSignatureFromTransaction(signed);
        await retrying('send', () => rpc.sendTransaction(getBase64EncodedWireTransaction(signed as never), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
        for (let i = 0; i < 90; i++) {
            const { value } = await retrying('status', () => rpc.getSignatureStatuses([signature]).send());
            const s = value[0];
            if (s?.err) throw new Error(`${this.name} tx ${signature} failed: ${JSON.stringify(s.err, (_, x) => (typeof x === 'bigint' ? `${x}` : x))}`);
            if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return signature;
            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error(`${this.name} tx ${signature} not confirmed`);
    }
}

async function expectRejected(label: string, p: () => Promise<{ status: number; json: { error?: string } }>, code: string) {
    let r = await p();
    for (let i = 0; r.status === 503 && i < 8; i++) {
        await sleep(3000);
        r = await p();
    }
    const pass = r.status >= 400 && r.json?.error === code;
    record.checks.push({ check: label, expected: code, got: `${r.status} ${r.json?.error}`, pass });
    log(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${r.status} ${r.json?.error}`);
    if (!pass) throw new Error(`${label}: expected ${code}`);
}

export async function enroll(c: Client) {
    log(`\n== ${c.name} (${c.wallet.address})`);
    const ch = await c.signedChallenge('enroll');
    const req = await c.ok('POST', '/v1/enrollments', { challengeId: ch.challengeId, signature: ch.signature });
    log(`  enrollment request ${req.requestId} (signed challenge, status ${req.status})`);

    const approved = await operator('approve', req.requestId, '--operator', 'demo-operator');
    log(`  operator approved -> operation ${approved.operationId}, participant ${approved.participantIdHex.slice(0, 12)}…`);
    const op = await retrying('operator run', () => operator('run', approved.operationId));
    log(`  operator issued badge; operation at step ${op.step}`);

    const regTx = await retrying('registration tx', () => c.ok('POST', `/v1/enrollments/${req.requestId}/registration-transaction`));
    const regSig = await c.signAndSend(regTx.transactionBase64);
    log(`  wallet signed + sent register_participant: ${regSig}`);

    const confirmed = await retrying('confirm', () => c.ok('POST', `/v1/enrollments/${req.requestId}/confirm`));
    log(`  confirm: step=${confirmed.operation.step} eligible=${confirmed.eligibility.eligible} slot=${confirmed.eligibility.slot}`);
    if (!confirmed.eligibility.eligible) throw new Error(`${c.name} not eligible after enrollment`);

    let s = await c.signedChallenge('session');
    const session = await retrying('session', async () => {
        s = await c.signedChallenge('session'); // challenges are single-use: sign a fresh one per attempt
        return c.ok('POST', '/v1/sessions', { challengeId: s.challengeId, signature: s.signature });
    });
    log(`  session opened (HttpOnly cookie), expires ${session.expiresAt}`);
    return { request: req.requestId, operation: approved.operationId, participantIdHex: approved.participantIdHex, registerSignature: regSig, eligibility: confirmed.eligibility, sessionChallenge: s };
}

export async function intent(c: Client, body: Record<string, unknown>) {
    const prepared = await retrying('prepare', () => c.ok('POST', '/v1/intents/prepare', body));
    const sig = await c.signAndSend(prepared.transactionBase64);
    const admitted = await retrying('admit', () => c.ok('POST', '/v1/intents/admit', { intent: prepared.intent, contentsHex: prepared.contentsHex }));
    log(`  ${body.kind} intent ${prepared.intent} nonce=${prepared.nonce} submitted ${sig}; admitted=${admitted.admitted} at slot ${admitted.observedSlot}`);
    return { intent: prepared.intent as Address, nonce: prepared.nonce, signature: sig, contentsHex: prepared.contentsHex as string, observedSlot: admitted.observedSlot };
}

async function main() {
    await operator('list'); // fails fast if the operator DB / keys are not reachable
    const health = await fetch(`${serviceUrl}/healthz`).then(r => r.json()).catch(() => null);
    if (!health?.ok) throw new Error(`service not reachable at ${serviceUrl}`);

    // Demo wallets stand in for users' browser wallets; give each a little SOL for fees and rent.
    const payer = await loadSigner('keys/payer.json');
    const clients: Client[] = [];
    for (const name of ['alice', 'bob', 'mallory']) {
        const path = `keys/demo/${runId}-client-${name}.json`;
        await generateKeypairFile(path);
        const wallet = await loadSigner(path);
        await sendAndConfirm({ rpc, feePayer: payer, instructions: [getTransferSolInstruction({ source: payer, destination: wallet.address, amount: lamports(30_000_000n) })] });
        clients.push(new Client(name, wallet));
    }
    const [alice, bob, mallory] = clients;
    log(`funded alice ${alice.wallet.address}, bob ${bob.wallet.address}, mallory ${mallory.wallet.address} (0.03 SOL each)`);

    const a = await enroll(alice);
    const b = await enroll(bob);

    log('\n== gated actions');
    const ai = await intent(alice, {
        kind: 'trade', target: bob.wallet.address,
        trade: { side: 'buy', points: [{ price: '100', quantity: '5' }, { price: '110', quantity: '3' }] },
    });
    const bi = await intent(bob, { kind: 'nomination', target: alice.wallet.address, nomination: { candidate: alice.wallet.address } });

    log('\n== rejections');
    await expectRejected('unenrolled wallet cannot open a session', async () => {
        const ms = await mallory.signedChallenge('session');
        return mallory.http('POST', '/v1/sessions', { challengeId: ms.challengeId, signature: ms.signature });
    }, 'NotEligible');
    await expectRejected('unenrolled wallet cannot prepare an intent', () => mallory.http('POST', '/v1/intents/prepare', { kind: 'nomination', target: alice.wallet.address, nomination: { candidate: alice.wallet.address } }), 'NoSession');
    await expectRejected('replayed session challenge is refused', () => alice.http('POST', '/v1/sessions', { challengeId: a.sessionChallenge.challengeId, signature: a.sessionChallenge.signature }), 'ChallengeReplayed');
    await expectRejected("bob cannot admit alice's intent", () => bob.http('POST', '/v1/intents/admit', { intent: ai.intent, contentsHex: ai.contentsHex }), 'IntentOwnerMismatch');
    await expectRejected('an intent cannot be admitted twice', () => alice.http('POST', '/v1/intents/admit', { intent: ai.intent, contentsHex: ai.contentsHex }), 'IntentAlreadyAdmitted');

    const elig = (w: Address) => retrying('eligibility', async () => {
        const r = await fetch(`${serviceUrl}/v1/wallets/${w}/eligibility`);
        if (r.status === 503) throw new Error('-> 503');
        return r.json();
    });
    for (const c of clients) {
        const e = await elig(c.wallet.address);
        log(`  eligibility ${c.name}: attestationValid=${e.attestationValid} registryActive=${e.registryActive} eligible=${e.eligible}${e.reasons?.length ? ` reasons=${e.reasons.map((r: { code: string }) => r.code).join(',')}` : ''}`);
        record.users[c.name] = { wallet: c.wallet.address, eligibility: e };
    }
    Object.assign(record.users.alice as object, { enrollment: { ...a, sessionChallenge: undefined }, intent: ai });
    Object.assign(record.users.bob as object, { enrollment: { ...b, sessionChallenge: undefined }, intent: bi });

    await mkdir('docs/rollout', { recursive: true });
    const out = `docs/rollout/${network}-two-user-client.json`;
    await writeFile(out, JSON.stringify(record, null, 2) + '\n');
    log(`\nrecord written to ${out}`);
}

if (import.meta.main) main().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
});
