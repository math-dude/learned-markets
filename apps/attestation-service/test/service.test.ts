import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getTransactionDecoder,
    partiallySignTransaction,
    type Address,
    type KeyPairSigner,
    type Transaction,
} from '@solana/kit';
import { fromHex, IntentState, ParticipantStatus, payloadHash, toHex, encodeTrade, findIntentPda } from '@learned-markets/attestations';
import { approveRequest, runOperation } from '../src/operations.ts';
import { CONFIG, FakeExecutor, harness, ORIGIN, type Harness } from './helpers.ts';

const executor = (h: Harness) => new FakeExecutor(h.chain);

async function enrollRequest(h: Harness, w: KeyPairSigner) {
    const s = await h.signChallenge(w, 'enroll');
    const r = await h.req('POST', '/v1/enrollments', { body: s });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.requestId as string;
}

/** Full enrollment: approve → issue → participant registers → confirm. */
async function enrolled(h: Harness, w: KeyPairSigner, ex = executor(h)) {
    const requestId = await enrollRequest(h, w);
    const { operationId, participantIdHex, intended } = await approveRequest(h.db, h.chain, requestId, 'op');
    let op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.step, 'await_registration');
    assert.equal(op.status, 'awaiting_participant');
    const tx = await h.req('POST', `/v1/enrollments/${requestId}/registration-transaction`);
    assert.equal(tx.status, 200, JSON.stringify(tx.json));
    await h.chain.bind(participantIdHex, w.address, intended.attestation, 1);
    const confirm = await h.req('POST', `/v1/enrollments/${requestId}/confirm`);
    assert.equal(confirm.json.operation.status, 'completed', JSON.stringify(confirm.json));
    assert.equal(confirm.json.eligibility.eligible, true);
    return { requestId, operationId, participantIdHex, intended, ex };
}

// ------------------------------------------------------------- challenges

test('challenge binds origin, wallet, action, nonce and expiry', async () => {
    const h = await harness();
    const w = await h.wallet();
    const s = await h.signChallenge(w, 'enroll');
    assert.match(s.message, new RegExp(`^lm\\.example wants you to sign with your Solana account:\\n${w.address}\\n`));
    assert.match(s.message, /Action: learned-markets:enroll/);
    assert.match(s.message, new RegExp(`Origin: ${ORIGIN}`));
    assert.match(s.message, /Nonce: [0-9a-f]{32}/);
    assert.match(s.message, /Expiration Time: /);
});

test('challenge replay, wrong action, wrong signature, tampered message and expiry are rejected', async () => {
    const h = await harness();
    const w = await h.wallet();
    const other = await h.wallet();

    const s = await h.signChallenge(w, 'enroll');
    assert.equal((await h.req('POST', '/v1/enrollments', { body: s })).status, 201);
    const replay = await h.req('POST', '/v1/enrollments', { body: s });
    assert.equal(replay.json.error, 'ChallengeReplayed');

    const sess = await h.signChallenge(w, 'session');
    assert.equal((await h.req('POST', '/v1/enrollments', { body: sess })).json.error, 'WrongAction');

    const forged = await h.signChallenge(w, 'enroll', undefined, other);
    assert.equal((await h.req('POST', '/v1/enrollments', { body: forged })).json.error, 'BadSignature');

    // Signature over a message naming a different origin does not verify against the stored challenge.
    const ch = await h.req('POST', '/v1/challenges', { body: { wallet: other.address, action: 'enroll' } });
    const { signBytes, getBase58Decoder } = await import('@solana/kit');
    const tampered = (ch.json.message as string).replace(ORIGIN, 'https://evil.example');
    const sig = getBase58Decoder().decode(await signBytes(other.keyPair.privateKey, new TextEncoder().encode(tampered)));
    assert.equal((await h.req('POST', '/v1/enrollments', { body: { challengeId: ch.json.challengeId, signature: sig } })).json.error, 'BadSignature');

    const late = await h.signChallenge(other, 'enroll');
    h.advance(5 * 60 * 1000);
    assert.equal((await h.req('POST', '/v1/enrollments', { body: late })).json.error, 'ChallengeExpired');
});

test('cross-origin requests are rejected', async () => {
    const h = await harness();
    const w = await h.wallet();
    const r = await h.req('POST', '/v1/challenges', { body: { wallet: w.address, action: 'enroll' }, origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'BadOrigin');
    const ok = await h.req('POST', '/v1/challenges', { body: { wallet: w.address, action: 'enroll' }, origin: ORIGIN });
    assert.equal(ok.status, 201);
});

test('replace challenges must name the replaced wallet', async () => {
    const h = await harness();
    const w = await h.wallet();
    assert.equal((await h.req('POST', '/v1/challenges', { body: { wallet: w.address, action: 'replace' } })).json.error, 'MissingReplacesWallet');
});

// ------------------------------------------------------------- approvals

test('one pending request per wallet; concurrent approvals have one winner', async () => {
    const h = await harness();
    const w = await h.wallet();
    const requestId = await enrollRequest(h, w);
    const again = await h.signChallenge(w, 'enroll');
    assert.equal((await h.req('POST', '/v1/enrollments', { body: again })).json.error, 'RequestPending');

    const results = await Promise.allSettled([
        approveRequest(h.db, h.chain, requestId, 'alice'),
        approveRequest(h.db, h.chain, requestId, 'bob'),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'NotPending');
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number }).n, 1);
});

test('two requests cannot open operations for the same participant (no duplicate issuance)', async () => {
    const h = await harness();
    const pid = 'ab'.repeat(32);
    const r1 = await enrollRequest(h, await h.wallet());
    const r2 = await enrollRequest(h, await h.wallet());
    await approveRequest(h.db, h.chain, r1, 'op', { participantIdHex: pid });
    await assert.rejects(approveRequest(h.db, h.chain, r2, 'op', { participantIdHex: pid }), (e: { code: string }) => e.code === 'OperationInProgress');
});

test('enrollment of an already-registered participant or bound wallet is refused', async () => {
    const h = await harness();
    const w = await h.wallet();
    const { participantIdHex } = await enrolled(h, w);
    const r = await enrollRequest(h, await h.wallet());
    await assert.rejects(approveRequest(h.db, h.chain, r, 'op', { participantIdHex }), (e: { code: string }) => e.code === 'ParticipantExists');
});

// ------------------------------------------------------------- operations

test('enrollment issues once and is idempotent when re-run', async () => {
    const h = await harness();
    const { operationId, ex } = await enrolled(h, await h.wallet());
    assert.equal(ex.count('issue'), 1);
    const op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.status, 'completed');
    assert.equal(ex.count('issue'), 1);
    const txs = h.db.prepare('SELECT step, status FROM operation_txs WHERE operation_id = ?').all(operationId).map(r => ({ ...r }));
    assert.deepEqual(txs, [{ step: 'issue', status: 'confirmed' }]);
});

test('timeouts are reconciled before any retry', async () => {
    const h = await harness();
    const w = await h.wallet();
    const requestId = await enrollRequest(h, w);
    const { operationId } = await approveRequest(h.db, h.chain, requestId, 'op');
    const ex = executor(h);

    // Landed but unconfirmed when we timed out.
    ex.fail.set('issue', 'timeout');
    let op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.status, 'needs_reconcile');
    const sig = (h.db.prepare('SELECT signature, status FROM operation_txs').get() as { signature: string; status: string });
    assert.equal(sig.status, 'submitted', 'signature persisted before submission');
    // Probe sees the attestation → advance without re-issuing.
    op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.step, 'await_registration');
    assert.equal(ex.count('issue'), 1);
});

test('expired, never-landed submissions are retried after reconciliation', async () => {
    const h = await harness();
    const requestId = await enrollRequest(h, await h.wallet());
    const { operationId } = await approveRequest(h.db, h.chain, requestId, 'op');
    const ex = executor(h);
    ex.lostIssuance = true;
    ex.fail.set('issue', 'timeout');
    let op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.status, 'needs_reconcile');
    // Still pending at the RPC: do not resubmit.
    op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.status, 'needs_reconcile');
    assert.equal(ex.count('issue'), 1);
    // Blockhash expired and nothing landed: retry is now safe.
    const first = h.db.prepare('SELECT signature FROM operation_txs').get() as { signature: string };
    ex.outcomes.set(first.signature, 'expired');
    ex.lostIssuance = false;
    op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.step, 'await_registration');
    assert.equal(ex.count('issue'), 2);
    const statuses = h.db.prepare('SELECT status FROM operation_txs ORDER BY id').all().map(r => (r as { status: string }).status);
    assert.deepEqual(statuses, ['expired', 'confirmed']);
});

async function signReplacement(h: Harness, requestId: string, newWallet: KeyPairSigner) {
    const prepared = await h.req('POST', `/v1/replacements/${requestId}/transaction`);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.json));
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.json.transactionBase64)) as Transaction;
    const signed = await partiallySignTransaction([newWallet.keyPair], tx);
    return h.req('POST', `/v1/replacements/${requestId}/signature`, { body: { transactionBase64: getBase64EncodedWireTransaction(signed as never) } });
}

test('interrupted wallet replacement resumes, never restores the old binding, and preserves identity', async () => {
    const h = await harness();
    const oldW = await h.wallet();
    const { participantIdHex, intended: oldBadge, ex } = await enrolled(h, oldW);
    h.db.prepare(`INSERT INTO registry_index VALUES (?, ?, ?, 1, 'Active', ?, '0', '1', 0)`).run('p', participantIdHex, oldW.address, oldBadge.attestation);
    h.chain.participants.get(participantIdHex)!.nextIntentNonce = 7n;

    const newW = await h.wallet();
    const s = await h.signChallenge(newW, 'replace', oldW.address);
    const reqRes = await h.req('POST', '/v1/replacements', { body: s });
    assert.equal(reqRes.status, 201, JSON.stringify(reqRes.json));
    const requestId = reqRes.json.requestId;
    const { operationId, bindingVersion, intended } = await approveRequest(h.db, h.chain, requestId, 'op');
    assert.equal(bindingVersion, 2);

    // Crash right after the suspension was sent.
    ex.fail.set('suspend', 'crash-after-send');
    let op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.status, 'needs_reconcile');
    assert.equal((await h.chain.eligibility(oldW.address)).eligible, false, 'old binding is ineligible once suspended');

    // Revocation fails in preflight: operation is failed but resumable; nothing is restored.
    ex.fail.set('revoke', 'reject');
    op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.status, 'failed');
    assert.equal(op.step, 'revoke_old');
    assert.equal(h.chain.participants.get(participantIdHex)!.status, ParticipantStatus.Suspended);
    assert.equal(ex.count('suspend'), 1, 'suspension not re-sent');

    // Resume: revoke, issue v2, then wait for the new wallet's signature.
    op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.step, 'await_replacement_signature');
    assert.equal(op.status, 'awaiting_participant');
    assert.equal(h.chain.attestations.has(oldBadge.attestation), false);
    assert.equal(h.chain.attestations.has(intended.attestation), true);

    // Missing new-wallet signature, or an altered message, is refused.
    const prepared = await h.req('POST', `/v1/replacements/${requestId}/transaction`);
    const unsigned = await h.req('POST', `/v1/replacements/${requestId}/signature`, { body: { transactionBase64: prepared.json.transactionBase64 } });
    assert.equal(unsigned.json.error, 'BadSignature');
    const bytes = new Uint8Array(Buffer.from(prepared.json.transactionBase64, 'base64'));
    bytes[bytes.length - 1] ^= 1;
    const altered = await h.req('POST', `/v1/replacements/${requestId}/signature`, { body: { transactionBase64: Buffer.from(bytes).toString('base64') } });
    assert.equal(altered.json.error, 'MessageMismatch');

    const good = await signReplacement(h, requestId, newW);
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.equal(good.json.step, 'cosign');

    ex.onCosign = () => h.chain.bind(participantIdHex, newW.address, intended.attestation, 2);
    op = await runOperation(h.db, h.chain, ex, operationId);
    assert.equal(op.status, 'completed', op.last_error ?? '');
    const p = h.chain.participants.get(participantIdHex)!;
    assert.equal(p.currentWallet, newW.address);
    assert.equal(p.bindingVersion, 2);
    assert.equal(p.nextIntentNonce, 7n, 'nonce sequence preserved');
    assert.equal((await h.chain.eligibility(newW.address)).eligible, true);
    assert.equal((await h.chain.eligibility(oldW.address)).eligible, false);
});

// --------------------------------------------------------------- sessions

test('sessions: eligible-only, hashed, HttpOnly 15-minute cookies, revalidated on use', async () => {
    const h = await harness();
    const w = await h.wallet();
    const stranger = await h.wallet();
    assert.equal((await h.login(stranger)).res.json.error, 'NotEligible');

    const { participantIdHex } = await enrolled(h, w);
    const { res, cookie } = await h.login(w);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const setCookie = res.headers.get('set-cookie')!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=900/);
    const token = cookie!.split('=')[1];
    const stored = h.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    assert.notEqual(stored.token_hash, token, 'token stored hashed');

    assert.equal((await h.req('GET', '/v1/me', { cookie })).json.eligible, true);

    // Suspension invalidates the session at the next privileged use.
    h.chain.participants.get(participantIdHex)!.status = ParticipantStatus.Suspended;
    const denied = await h.req('POST', '/v1/intents/prepare', { cookie, body: { kind: 'nomination', target: CONFIG.admin, nomination: { candidate: CONFIG.schema } } });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'NotEligible');
    assert.equal((await h.req('GET', '/v1/me', { cookie })).json.error, 'NoSession');

    // Re-activated; new session expires after 15 minutes; logout revokes.
    h.chain.participants.get(participantIdHex)!.status = ParticipantStatus.Active;
    const second = await h.login(w);
    assert.equal((await h.req('GET', '/v1/me', { cookie: second.cookie })).status, 200);
    assert.equal((await h.req('DELETE', '/v1/sessions', { cookie: second.cookie })).status, 204);
    assert.equal((await h.req('GET', '/v1/me', { cookie: second.cookie })).json.error, 'NoSession');
    const third = await h.login(w);
    h.advance(15 * 60 * 1000);
    assert.equal((await h.req('GET', '/v1/me', { cookie: third.cookie })).json.error, 'NoSession');
});

test('RPC failures deny privileged actions', async () => {
    const h = await harness();
    const w = await h.wallet();
    await enrolled(h, w);
    const { cookie } = await h.login(w);
    h.chain.rpcDown = true;
    const e = await h.req('GET', `/v1/wallets/${w.address}/eligibility`);
    assert.equal(e.status, 503);
    assert.equal(e.json.eligible, false);
    assert.equal((await h.req('POST', '/v1/intents/prepare', { cookie, body: { kind: 'nomination', target: CONFIG.admin, nomination: { candidate: CONFIG.schema } } })).status, 503);
    assert.equal((await h.login(w)).res.status, 503);
    h.chain.rpcDown = false;
    assert.equal((await h.req('GET', '/v1/me', { cookie })).json.eligible, true, 'session survives a transient outage');
});

test('status responses report attestation, registry and eligibility separately with the observed slot', async () => {
    const h = await harness();
    const w = await h.wallet();
    const { participantIdHex } = await enrolled(h, w);
    h.chain.badgeExpiry = h.chain.clock;
    const r = (await h.req('GET', `/v1/wallets/${w.address}/eligibility`)).json;
    assert.deepEqual([r.attestationValid, r.registryActive, r.eligible], [false, true, false]);
    assert.equal(r.slot, '100');
    assert.ok(r.reasons.length > 0);
    assert.equal(r.participant.participantIdHex, participantIdHex);
});

// ---------------------------------------------------------------- intents

test('intents are admitted only after the matching gated intent is confirmed', async () => {
    const h = await harness();
    const w = await h.wallet();
    const { participantIdHex } = await enrolled(h, w);
    const { cookie } = await h.login(w);
    const market = CONFIG.schemaMint;
    const trade = { side: 'buy', points: [{ price: '100', quantity: '5000' }, { price: '120', quantity: '2000' }] };

    const bad = await h.req('POST', '/v1/intents/prepare', { cookie, body: { kind: 'trade', target: market, trade: { side: 'buy', points: [{ price: '120', quantity: '1' }, { price: '100', quantity: '2' }] } } });
    assert.equal(bad.json.error, 'MalformedPayload');

    const prep = await h.req('POST', '/v1/intents/prepare', { cookie, body: { kind: 'trade', target: market, trade } });
    assert.equal(prep.status, 200, JSON.stringify(prep.json));
    assert.ok(BigInt(prep.json.deadline) <= h.chain.clock + 300n);
    const p = h.chain.participants.get(participantIdHex)!;
    assert.equal(prep.json.intent, await findIntentPda(p.address, 0n));
    const contents = encodeTrade({ side: 'buy', points: trade.points.map(x => ({ price: BigInt(x.price), quantity: BigInt(x.quantity) })) });
    assert.equal(prep.json.payloadHashHex, toHex(payloadHash(CONFIG.appScope, CONFIG.network, 0, market, contents)));

    // Not yet on chain.
    assert.equal((await h.req('POST', '/v1/intents/admit', { cookie, body: { intent: prep.json.intent } })).json.error, 'IntentNotConfirmed');

    const onchain = {
        version: 1, bump: 255, participant: p.address, wallet: w.address, bindingVersion: 1, nonce: 0n, kind: 0, target: market,
        payloadHash: fromHex(prep.json.payloadHashHex), createdAt: h.chain.clock, deadline: BigInt(prep.json.deadline), state: IntentState.Open, slot: 101n,
    };
    h.chain.intents.set(prep.json.intent, onchain);
    const modified = toHex(encodeTrade({ side: 'buy', points: [{ price: 100n, quantity: 5001n }] }));
    assert.equal((await h.req('POST', '/v1/intents/admit', { cookie, body: { intent: prep.json.intent, contentsHex: modified } })).json.error, 'PayloadHashMismatch');

    for (const [expected, code] of [[{ expectedTarget: CONFIG.admin }, 'IntentTargetMismatch'], [{ expectedKind: 'nomination' }, 'IntentKindMismatch']] as const) {
        const denied = await h.req('POST', '/v1/intents/admit', { cookie, body: { intent: prep.json.intent, ...expected } });
        assert.equal(denied.json.error, code);
    }
    const ok = await h.req('POST', '/v1/intents/admit', { cookie, body: { intent: prep.json.intent, expectedTarget: market, expectedKind: 'trade' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.observedSlot, '101');
    assert.equal((await h.req('POST', '/v1/intents/admit', { cookie, body: { intent: prep.json.intent } })).json.error, 'IntentAlreadyAdmitted');

    // Cancelled, expired and stale-binding intents are refused.
    for (const [patch, code] of [
        [{ state: IntentState.Cancelled }, 'IntentNotOpen'],
        [{ deadline: h.chain.clock }, 'IntentExpired'],
        [{ bindingVersion: 0 }, 'StaleIntentBinding'],
        [{ participant: CONFIG.admin }, 'IntentOwnerMismatch'],
    ] as const) {
        const addr = `${prep.json.intent}` as Address;
        h.db.prepare('DELETE FROM admitted_intents').run();
        h.chain.intents.set(addr, { ...onchain, ...patch });
        assert.equal((await h.req('POST', '/v1/intents/admit', { cookie, body: { intent: addr } })).json.error, code);
    }
});

// ---------------------------------------------------------------- metadata

test('public badge metadata is served from the configured HTTPS origin', async () => {
    const h = await harness();
    const m = await h.req('GET', '/v1/badge/metadata.json');
    assert.equal(m.json.symbol, 'LMTEST');
    assert.equal(m.json.name, 'Learned Markets Demo Pass');
    assert.equal(m.json.image, 'https://badges.lm.example/v1/badge/image.svg');
    const img = await h.app.request('/v1/badge/image.svg');
    assert.equal(img.headers.get('content-type'), 'image/svg+xml');
    const { loadConfig } = await import('../src/config.ts');
    assert.throws(() => loadConfig({ SERVICE_ORIGIN: 'http://lm.example' }), /https/);
});
