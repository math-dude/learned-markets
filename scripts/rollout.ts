/**
 * Rollout demonstration (plan §5, steps 3–6). Idempotent where possible.
 *
 *   LM_RPC_URL=https://api.devnet.solana.com LM_NETWORK=devnet \
 *   LM_BADGE_URI=https://<badge-origin>/v1/badge/metadata.json node scripts/rollout.ts
 *
 * Uses operator keys from ./keys (see `lm-attest keys:init`) plus local demo
 * participant wallets (keys/demo/<run>-*.json). Records program addresses, config,
 * transaction signatures and expected rejections to docs/rollout/<network>.json.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { getTransferSolInstruction } from '@solana-program/system';
import { lamports, type Address, type KeyPairSigner } from '@solana/kit';
import {
    badgeAddresses,
    cancelIntentInstruction,
    checkEligibility,
    decodeConfig,
    decodeParticipant,
    encodeTrade,
    findConfigPda,
    findParticipantPda,
    findWalletBindingPda,
    generateKeypairFile,
    initializeGate,
    inspectAttestation,
    IntentKind,
    issueBadge,
    issuerAddresses,
    LEARNED_MARKETS_PROGRAM_ADDRESS,
    loadSigner,
    payloadHash,
    registerParticipantInstruction,
    replaceBindingInstruction,
    revokeBadge,
    revokeParticipant,
    rpcFor,
    sendAndConfirm,
    settleBatchInstruction,
    setupIssuer,
    submitIntentInstruction,
    suspendParticipant,
    toHex,
    type IssuerAddresses,
} from '@learned-markets/attestations';

const rpcUrl = process.env.LM_RPC_URL ?? 'http://127.0.0.1:8899';
const network = process.env.LM_NETWORK ?? 'localnet';
const badgeUri = process.env.LM_BADGE_URI ?? 'https://badges.learned-markets.test/v1/badge/metadata.json';
const recordPath = `docs/rollout/${network}.json`;
// Demo wallets are per run: a wallet, once bound, can never be bound to another participant.
const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const rpc = rpcFor(rpcUrl);

type Step = { step: string; ok: boolean; signature?: string; expectedError?: string; note?: string; [k: string]: unknown };
const record: { runId: string; network: string; rpcUrl: string; programId: Address; badgeUri: string; startedAt: string; addresses: Record<string, unknown>; steps: Step[] } = {
    runId, network, rpcUrl, programId: LEARNED_MARKETS_PROGRAM_ADDRESS, badgeUri, startedAt: new Date().toISOString(), addresses: {}, steps: [],
};
const log = (s: Step) => {
    record.steps.push(s);
    console.log(`${s.ok ? '✔' : '✖'} ${s.step}${s.signature ? `  ${s.signature}` : ''}${s.expectedError ? `  [rejected: ${s.expectedError}]` : ''}`);
};

function errorCode(e: unknown): string {
    const text = JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + String((e as Error)?.message ?? '');
    return text.match(/Error Code: (\w+)/)?.[1] ?? text.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? (e as Error)?.message ?? 'unknown';
}

async function expectReject(step: string, expected: string, f: () => Promise<unknown>) {
    try {
        await f();
        log({ step, ok: false, note: `expected ${expected}, but it succeeded` });
        process.exitCode = 1;
    } catch (e) {
        const code = errorCode(e);
        const ok = code === expected;
        log({ step, ok, expectedError: code, note: ok ? undefined : `expected ${expected}` });
        if (!ok) process.exitCode = 1;
    }
}

async function wallet(name: string): Promise<KeyPairSigner> {
    const path = `keys/demo/${runId}-${name}.json`;
    try {
        await access(path);
    } catch {
        await generateKeypairFile(path);
    }
    return loadSigner(path);
}

async function fund(payer: KeyPairSigner, to: Address, sol: number) {
    const { value } = await rpc.getBalance(to, { commitment: 'confirmed' }).send();
    const want = BigInt(Math.round(sol * 1e9));
    if (value >= want) return;
    await sendAndConfirm({ rpc, feePayer: payer, instructions: [getTransferSolInstruction({ source: payer, destination: to, amount: lamports(want - value) })] });
}

async function badgeAccounts(issuer: IssuerAddresses, pid: Uint8Array, version: number, w: Address) {
    const a = await badgeAddresses(issuer, pid, version, w);
    return { ...issuer, attestation: a.attestation, badgeMint: a.badgeMint, badgeTokenAccount: a.badgeTokenAccount };
}

async function main() {
    const keys = Object.fromEntries(
        await Promise.all(['payer', 'credential-authority', 'issuance-signer', 'admin', 'deployer', 'settlement-authority'].map(async n => [n, await loadSigner(`keys/${n}.json`)])),
    ) as Record<string, KeyPairSigner>;
    const payer = keys.payer;

    // 1–2: issuer and gate config.
    const { issuer, signatures } = await setupIssuer(rpc, { payer, credentialAuthority: keys['credential-authority'], issuanceSigner: keys['issuance-signer'].address });
    log({ step: 'issuer:setup (credential, schema v1, schema group max 1,000,000)', ok: true, note: JSON.stringify(signatures) });
    record.addresses.issuer = issuer;
    const configAddress = await findConfigPda();
    const existing = await rpc.getAccountInfo(configAddress, { encoding: 'base64', commitment: 'confirmed' }).send();
    if (!existing.value) {
        const tx = await initializeGate(rpc, {
            payer, deployer: keys.deployer, issuer, credentialAuthority: keys['credential-authority'].address,
            admin: keys.admin.address, settlementAuthority: keys['settlement-authority'].address, network,
        });
        log({ step: 'gate:initialize_config (deployment authority)', ok: true, signature: tx.signature });
    } else log({ step: 'gate:initialize_config', ok: true, note: 'already initialized' });
    const cfgAcct = await rpc.getAccountInfo(configAddress, { encoding: 'base64', commitment: 'confirmed' }).send();
    const config = decodeConfig(new Uint8Array(Buffer.from(cfgAcct.value!.data[0], 'base64')));
    record.addresses.config = { address: configAddress, ...config };

    // 5: two demo participants.
    const [alice, aliceNew, bob, mallory] = await Promise.all(['alice', 'alice-new', 'bob', 'mallory'].map(wallet));
    for (const w of [alice, aliceNew, bob, mallory]) await fund(payer, w.address, 0.05);
    const pidA = new Uint8Array(randomBytes(32));
    const pidB = new Uint8Array(randomBytes(32));
    record.addresses.participants = {
        alice: { wallet: alice.address, replacementWallet: aliceNew.address, participantIdHex: toHex(pidA), participant: await findParticipantPda(pidA) },
        bob: { wallet: bob.address, participantIdHex: toHex(pidB), participant: await findParticipantPda(pidB) },
        mallory: { wallet: mallory.address, note: 'never approved' },
    };

    for (const [name, w, pid] of [['alice', alice, pidA], ['bob', bob, pidB]] as const) {
        const issued = await issueBadge(rpc, { payer, issuanceSigner: keys['issuance-signer'] }, issuer, { participantId: pid, wallet: w.address, bindingVersion: 1, uri: badgeUri });
        log({ step: `badge:issue ${name} v1 (LMTEST, mint space ${issued.mintAccountSpace})`, ok: true, signature: issued.signature, attestation: issued.attestation, badgeMint: issued.badgeMint });
        const ix = await registerParticipantInstruction({ payer: w, wallet: w, participantId: pid, badge: await badgeAccounts(issuer, pid, 1, w.address) });
        const tx = await sendAndConfirm({ rpc, feePayer: w, instructions: [ix] });
        log({ step: `register_participant ${name}`, ok: true, signature: tx.signature });
    }

    // Gated admission.
    const market = keys['settlement-authority'].address; // any non-default target for the demo
    const contents = encodeTrade({ side: 'buy', points: [{ price: 100n, quantity: 5_000n }, { price: 120n, quantity: 2_000n }] });
    const hash = payloadHash(config.appScope, config.network, IntentKind.Trade, market, contents);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const submit = async (w: KeyPairSigner, pid: Uint8Array, version: number, nonce: bigint) => {
        const ix = await submitIntentInstruction({
            wallet: w, participantId: pid, badge: await badgeAccounts(issuer, pid, version, w.address), nonce, kind: IntentKind.Trade, target: market, payloadHash: hash, deadline: now + 240n,
        });
        return { ix, tx: await sendAndConfirm({ rpc, feePayer: w, instructions: [ix] }) };
    };
    const a0 = await submit(alice, pidA, 1, 0n);
    log({ step: 'submit_intent alice nonce 0 (gated admission)', ok: true, signature: a0.tx.signature, intent: a0.ix.intent });
    const elig = await checkEligibility(rpc, alice.address);
    log({ step: 'eligibility alice', ok: elig.eligible, attestationValid: elig.attestationValid, registryActive: elig.registryActive, slot: elig.slot });

    // Direct-call rejection: Mallory (no badge, no binding) calls the program directly.
    await expectReject('direct submit_intent by unapproved wallet (Mallory, own binding)', 'AccountNotInitialized', async () => {
        const ix = await submitIntentInstruction({ wallet: mallory, participantId: pidA, badge: await badgeAccounts(issuer, pidA, 1, alice.address), nonce: 1n, kind: IntentKind.Trade, target: market, payloadHash: hash, deadline: now + 240n });
        await sendAndConfirm({ rpc, feePayer: mallory, instructions: [ix] });
    });
    // A badge issued to Carol, who has not registered yet: Mallory cannot use it.
    const carol = await wallet('carol');
    const pidC = new Uint8Array(randomBytes(32));
    const carolBadge = await issueBadge(rpc, { payer, issuanceSigner: keys['issuance-signer'] }, issuer, { participantId: pidC, wallet: carol.address, bindingVersion: 1, uri: badgeUri });
    log({ step: 'badge:issue carol v1 (not registered)', ok: true, signature: carolBadge.signature });
    await expectReject("direct register_participant by Mallory with Carol's badge", 'WalletMismatch', async () => {
        const ix = await registerParticipantInstruction({ payer: mallory, wallet: mallory, participantId: pidC, badge: await badgeAccounts(issuer, pidC, 1, carol.address) });
        await sendAndConfirm({ rpc, feePayer: mallory, instructions: [ix] });
    });

    // Settlement scaffold.
    await expectReject('settle_batch (scaffold)', 'SettlementNotImplemented', async () => {
        const b = await badgeAccounts(issuer, pidA, 1, alice.address);
        const ix = await settleBatchInstruction({
            settlementAuthority: keys['settlement-authority'], credential: issuer.credential, schema: issuer.schema, schemaMint: issuer.schemaMint, market, batchId: 1n,
            items: [{ intent: a0.ix.intent, contents, participant: await findParticipantPda(pidA), walletBinding: await findWalletBindingPda(alice.address), attestation: b.attestation, badgeMint: b.badgeMint, badgeTokenAccount: b.badgeTokenAccount }],
        });
        await sendAndConfirm({ rpc, feePayer: payer, instructions: [ix] });
    });

    // Suspension and revocation (Bob).
    log({ step: 'suspend_participant bob', ok: true, signature: (await suspendParticipant(rpc, { payer, admin: keys.admin }, pidB)).signature });
    await expectReject('submit_intent by suspended bob', 'ParticipantNotActive', () => submit(bob, pidB, 1, 0n));
    log({ step: 'revoke_participant bob', ok: true, signature: (await revokeParticipant(rpc, { payer, admin: keys.admin }, pidB)).signature });
    const bobBadge = await badgeAddresses(issuer, pidB, 1, bob.address);
    log({ step: 'badge:revoke bob (SAS close: burn + close)', ok: true, signature: (await revokeBadge(rpc, { payer, issuanceSigner: keys['issuance-signer'] }, issuer, { attestation: bobBadge.attestation, badgeTokenAccount: bobBadge.badgeTokenAccount })).signature });
    const bobElig = await checkEligibility(rpc, bob.address);
    log({ step: 'eligibility bob after revocation', ok: !bobElig.eligible && !bobElig.attestationValid && !bobElig.registryActive, reasons: bobElig.reasons.map(r => r.code) });

    // Wallet replacement (Alice → Alice-new).
    log({ step: 'suspend_participant alice (replacement step 1)', ok: true, signature: (await suspendParticipant(rpc, { payer, admin: keys.admin }, pidA)).signature });
    const aliceBadge = await badgeAddresses(issuer, pidA, 1, alice.address);
    log({ step: 'badge:revoke alice v1', ok: true, signature: (await revokeBadge(rpc, { payer, issuanceSigner: keys['issuance-signer'] }, issuer, { attestation: aliceBadge.attestation, badgeTokenAccount: aliceBadge.badgeTokenAccount })).signature });
    const v2 = await issueBadge(rpc, { payer, issuanceSigner: keys['issuance-signer'] }, issuer, { participantId: pidA, wallet: aliceNew.address, bindingVersion: 2, uri: badgeUri });
    log({ step: 'badge:issue alice v2 to replacement wallet', ok: true, signature: v2.signature, attestation: v2.attestation, badgeMint: v2.badgeMint });
    const rix = await replaceBindingInstruction({ payer, admin: keys.admin, newWallet: aliceNew, oldWallet: alice.address, participantId: pidA, badge: await badgeAccounts(issuer, pidA, 2, aliceNew.address) });
    log({ step: 'replace_binding (admin + new wallet)', ok: true, signature: (await sendAndConfirm({ rpc, feePayer: payer, instructions: [rix] })).signature });
    const pAcct = await rpc.getAccountInfo(await findParticipantPda(pidA), { encoding: 'base64', commitment: 'confirmed' }).send();
    const p = decodeParticipant(new Uint8Array(Buffer.from(pAcct.value!.data[0], 'base64')));
    log({ step: 'participant after replacement', ok: p.currentWallet === aliceNew.address && p.bindingVersion === 2 && p.nextIntentNonce === 1n, wallet: p.currentWallet, bindingVersion: p.bindingVersion, nextIntentNonce: p.nextIntentNonce.toString() });
    // The old wallet's binding is retained (inactive), so the gate reports it as not current.
    await expectReject('submit_intent by old wallet after replacement', 'WalletNotCurrent', () => submit(alice, pidA, 1, 1n));
    const a1 = await submit(aliceNew, pidA, 2, 1n);
    log({ step: 'submit_intent replacement wallet nonce 1 (nonce preserved)', ok: true, signature: a1.tx.signature, intent: a1.ix.intent });
    const cix = await cancelIntentInstruction({ wallet: aliceNew, participantId: pidA, nonce: 1n });
    log({ step: 'cancel_intent nonce 1', ok: true, signature: (await sendAndConfirm({ rpc, feePayer: aliceNew, instructions: [cix] })).signature });

    // Badge inspection for wallet rendering.
    const insp = await inspectAttestation(rpc, v2.attestation);
    log({ step: 'inspect alice v2 attestation', ok: insp.attestationValid, badgeMint: insp.badgeMint, expiry: insp.expiry });
    record.addresses.badgeMints = { aliceV2: v2.badgeMint, wallet: aliceNew.address };

    await mkdir('docs/rollout', { recursive: true });
    await writeFile(recordPath, JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v), 2) + '\n');
    console.log(`\nrecorded → ${recordPath}`);
}

main().catch(e => {
    console.error(e);
    process.exitCode = 1;
});
