import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
    getBase64Encoder,
    getPublicKeyFromAddress,
    getTransactionDecoder,
    getSignatureFromTransaction,
    getBase64EncodedWireTransaction,
    assertIsFullySignedTransaction,
    verifySignature,
    type Address,
    type SignatureBytes,
} from '@solana/kit';
import {
    badgeAddresses,
    BADGE_IMAGE_SVG,
    badgeMetadataJson,
    bytesEqual,
    encodeNomination,
    encodeTrade,
    fromHex,
    IntentKind,
    IntentState,
    MAX_INTENT_LIFETIME_SECS,
    payloadHash,
    PayloadError,
    registerParticipantInstruction,
    replaceBindingInstruction,
    RpcUnavailableError,
    submitIntentInstruction,
    toHex,
    validateContents,
    type EligibilityReport,
} from '@learned-markets/attestations';
import {
    ACTIONS,
    assertAddress,
    consumeChallenge,
    createChallenge,
    createSession,
    getSession,
    HttpError,
    revokeSession,
    revokeWalletSessions,
    type ChallengeAction,
    type Session,
} from './auth.ts';
import type { Chain } from './chain.ts';
import { SESSION_COOKIE, SESSION_TTL_MS, type ServiceConfig } from './config.ts';
import type { Db } from './db.ts';
import { createRequest, getOperation, getRequest, runOperation, type OperationRow } from './operations.ts';

const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createApp(deps: { db: Db; chain: Chain; config: ServiceConfig; now?: () => number }) {
    const { db, chain, config } = deps;
    const now = deps.now ?? Date.now;
    const app = new Hono();

    app.onError((err, c) => {
        if (err instanceof HttpError) return c.json({ error: err.code, message: err.message, details: jsonSafe(err.details ?? null) }, err.status as 400);
        if (err instanceof RpcUnavailableError)
            return c.json({ error: 'RpcUnavailable', message: 'chain state unavailable; privileged actions are denied', eligible: false }, 503);
        console.error(err);
        return c.json({ error: 'Internal', message: 'internal error' }, 500);
    });

    // CSRF: browsers always send Origin on cross-origin state-changing requests.
    app.use('*', async (c, next) => {
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
            const origin = c.req.header('origin');
            if (origin && origin !== config.origin) throw new HttpError(403, 'BadOrigin', 'cross-origin request rejected');
        }
        await next();
    });

    const body = async (c: Context): Promise<Record<string, unknown>> => {
        try {
            const v = await c.req.json();
            if (v && typeof v === 'object') return v as Record<string, unknown>;
        } catch {
            /* fallthrough */
        }
        throw new HttpError(400, 'BadRequest', 'JSON object body required');
    };

    const requireSession = (c: Context): Session => {
        const s = getSession(db, getCookie(c, SESSION_COOKIE), now());
        if (!s) throw new HttpError(401, 'NoSession', 'sign in with an eligible wallet');
        return s;
    };

    /** Fresh, uncached eligibility; denies (and ends the session) when ineligible. */
    const requireEligible = async (c: Context, session: Session): Promise<EligibilityReport> => {
        const report = await chain.eligibility(session.wallet);
        if (!report.eligible || report.participant?.address !== session.participant) {
            revokeSession(db, session.tokenHash, now());
            deleteCookie(c, SESSION_COOKIE, { path: '/' });
            throw new HttpError(403, 'NotEligible', 'wallet is not currently eligible', report);
        }
        return report;
    };

    // ------------------------------------------------------------- challenges

    app.post('/v1/challenges', async c => {
        const b = await body(c);
        const wallet = assertAddress(b.wallet, 'wallet');
        if (!ACTIONS.includes(b.action as ChallengeAction)) throw new HttpError(400, 'BadAction', `action must be one of ${ACTIONS.join(', ')}`);
        const replaces = b.replacesWallet ? assertAddress(b.replacesWallet, 'replacesWallet') : null;
        return c.json(createChallenge(db, config.origin, wallet, b.action as ChallengeAction, replaces, now()), 201);
    });

    // ------------------------------------------------------------- enrollment

    app.post('/v1/enrollments', async c => {
        const b = await body(c);
        const { wallet, challengeId } = await consumeChallenge(db, b.challengeId, b.signature, 'enroll', now());
        return c.json(createRequest(db, 'enroll', wallet, null, challengeId, b.signature as string, now()), 201);
    });

    app.post('/v1/replacements', async c => {
        const b = await body(c);
        const { wallet, replacesWallet, challengeId } = await consumeChallenge(db, b.challengeId, b.signature, 'replace', now());
        return c.json(createRequest(db, 'replace', wallet, replacesWallet, challengeId, b.signature as string, now()), 201);
    });

    const requestFor = (id: string) => {
        const r = getRequest(db, id);
        if (!r) throw new HttpError(404, 'UnknownRequest', 'request not found');
        return r;
    };
    const operationFor = (id: string): OperationRow => {
        const r = requestFor(id);
        if (!r.operation) throw new HttpError(409, 'NotApproved', 'awaiting operator approval');
        return getOperation(db, r.operation.id as string);
    };
    const badgeOf = async (op: OperationRow) => {
        const cfg = await chain.config();
        return {
            credential: cfg.credential,
            schema: cfg.schema,
            schemaMint: cfg.schemaMint,
            attestation: op.intended_attestation as Address,
            badgeMint: op.intended_badge_mint as Address,
            badgeTokenAccount: op.intended_token_account as Address,
        };
    };

    app.get('/v1/enrollments/:id', c => c.json(jsonSafe(requestFor(c.req.param('id')))));
    app.get('/v1/replacements/:id', c => c.json(jsonSafe(requestFor(c.req.param('id')))));

    /** Unsigned register_participant transaction for the enrolling wallet to sign and submit. */
    app.post('/v1/enrollments/:id/registration-transaction', async c => {
        const op = operationFor(c.req.param('id'));
        if (op.kind !== 'enroll' || op.step !== 'await_registration')
            throw new HttpError(409, 'WrongStep', `operation is at ${op.step}`);
        const ix = await registerParticipantInstruction({
            payer: op.wallet as Address, wallet: op.wallet as Address, participantId: fromHex(op.participant_id), badge: await badgeOf(op),
        });
        const built = await chain.buildWalletTransaction(op.wallet as Address, [ix]);
        rememberMessage(op.wallet as Address, built.transactionBase64);
        return c.json(jsonSafe(built));
    });

    /** Verifies both systems after the participant registered; activates access only when eligible. */
    app.post('/v1/enrollments/:id/confirm', async c => {
        const op = await runOperation(db, chain, null, operationFor(c.req.param('id')).id);
        const report = await chain.eligibility(op.wallet as Address);
        return c.json(jsonSafe({ operation: { step: op.step, status: op.status, lastError: op.last_error }, eligibility: report }));
    });

    /** replace_binding transaction: fee payer = operator payer; the new wallet signs here, the operator co-signs. */
    app.post('/v1/replacements/:id/transaction', async c => {
        const op = operationFor(c.req.param('id'));
        if (op.kind !== 'replace' || op.step !== 'await_replacement_signature')
            throw new HttpError(409, 'WrongStep', `operation is at ${op.step}`);
        if (!config.operatorPayer) throw new HttpError(503, 'NoOperatorPayer', 'OPERATOR_PAYER not configured');
        const cfg = await chain.config();
        const ix = await replaceBindingInstruction({
            payer: config.operatorPayer as Address, admin: cfg.admin, newWallet: op.wallet as Address,
            oldWallet: op.previous_wallet as Address | null, participantId: fromHex(op.participant_id), badge: await badgeOf(op),
        });
        const built = await chain.buildWalletTransaction(config.operatorPayer as Address, [ix]);
        db.prepare('UPDATE operations SET prepared_tx = ?, updated_at = ? WHERE id = ?').run(built.transactionBase64, now(), op.id);
        return c.json(jsonSafe(built));
    });

    app.post('/v1/replacements/:id/signature', async c => {
        const b = await body(c);
        const op = operationFor(c.req.param('id'));
        if (op.step !== 'await_replacement_signature' || !op.prepared_tx) throw new HttpError(409, 'WrongStep', 'no prepared transaction');
        if (typeof b.transactionBase64 !== 'string') throw new HttpError(400, 'BadRequest', 'transactionBase64 required');
        const dec = getTransactionDecoder();
        const prepared = dec.decode(getBase64Encoder().encode(op.prepared_tx));
        const signed = dec.decode(getBase64Encoder().encode(b.transactionBase64));
        if (!bytesEqual(new Uint8Array(prepared.messageBytes), new Uint8Array(signed.messageBytes)))
            throw new HttpError(400, 'MessageMismatch', 'signed transaction differs from the prepared one');
        const sig = signed.signatures[op.wallet as Address];
        const key = await getPublicKeyFromAddress(op.wallet as Address);
        if (!sig || !(await verifySignature(key, sig as SignatureBytes, signed.messageBytes)))
            throw new HttpError(401, 'BadSignature', 'new wallet signature missing or invalid');
        db.prepare('UPDATE operations SET participant_signed_tx = ?, updated_at = ? WHERE id = ?').run(b.transactionBase64, now(), op.id);
        return c.json(jsonSafe(await runOperation(db, chain, null, op.id).then(o => ({ step: o.step, status: o.status }))));
    });

    // --------------------------------------------------------------- sessions

    app.post('/v1/sessions', async c => {
        const b = await body(c);
        const { wallet } = await consumeChallenge(db, b.challengeId, b.signature, 'session', now());
        const report = await chain.eligibility(wallet);
        if (!report.eligible || !report.participant) throw new HttpError(403, 'NotEligible', 'wallet is not currently eligible', report);
        const { token, expiresAt } = createSession(db, wallet, report.participant.address, now());
        setCookie(c, SESSION_COOKIE, token, {
            httpOnly: true, secure: config.secureCookies, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_MS / 1000,
        });
        return c.json(jsonSafe({ wallet, expiresAt: new Date(expiresAt).toISOString(), eligibility: report }), 201);
    });

    app.delete('/v1/sessions', c => {
        const s = getSession(db, getCookie(c, SESSION_COOKIE), now());
        if (s) revokeSession(db, s.tokenHash, now());
        deleteCookie(c, SESSION_COOKIE, { path: '/' });
        return c.body(null, 204);
    });

    // ----------------------------------------------------------------- lookup

    async function verifiedNetwork() {
        const cfg = await chain.config();
        if (cfg.network !== config.network) throw new HttpError(409, 'NetworkMismatch', 'program and service network names differ');
        const genesisHash = await chain.genesisHash();
        if (cfg.network === 'surfpool') {
            const url = new URL(config.rpcUrl);
            if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
                throw new HttpError(409, 'NetworkMismatch', 'Surfpool requires a local or tunneled RPC');
            const version = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' }) });
            const info = await version.json() as { result?: { 'surfnet-version'?: unknown } };
            if (!version.ok || typeof info.result?.['surfnet-version'] !== 'string')
                throw new HttpError(409, 'NetworkMismatch', 'RPC is not Surfpool');
        } else if (cfg.network !== 'devnet' || genesisHash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') {
            throw new HttpError(409, 'NetworkMismatch', 'unexpected Solana cluster');
        }
        return { network: cfg.network, genesisHash };
    }

    app.get('/v1/network', async c => c.json(await verifiedNetwork()));

    // Privy's signature dialog estimates the fee and simulates the prepared
    // transaction. The browser never receives the validator's privileged RPC URL.
    const previewMethods = new Set(['getAccountInfo', 'getBalance', 'getFeeForMessage', 'getLatestBlockhash', 'simulateTransaction']);
    app.post('/v1/wallet-preview', async c => {
        const request = await body(c);
        const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
        if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !previewMethods.has(request.method))
            return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported preview method' } });
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method: request.method, params: request.params ?? [] });
        if (payload.length > 8192) throw new HttpError(413, 'PreviewTooLarge', 'wallet preview request too large');
        const res = await fetch(config.rpcUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
            headers: { 'content-type': 'application/json' }, body: payload });
        if (!res.ok) throw new HttpError(503, 'PreviewUnavailable', 'wallet preview unavailable');
        // Preserve Solana integer precision in RPC response bytes.
        return c.body(await res.text(), 200, { 'Content-Type': 'application/json' });
    });

    function rememberMessage(wallet: Address, wire: string) {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
        const hash = createHash('sha256').update(new Uint8Array(tx.messageBytes)).digest('hex');
        db.prepare('DELETE FROM wallet_messages WHERE expires_at <= ?').run(now());
        db.prepare('INSERT OR REPLACE INTO wallet_messages VALUES (?, ?, ?)').run(hash, wallet, now() + 300_000);
    }

    app.post('/v1/wallet-transactions', async c => {
        const b = await body(c);
        if (typeof b.transactionBase64 !== 'string' || b.transactionBase64.length > 1644)
            throw new HttpError(400, 'InvalidTransaction', 'expected a signed Solana transaction');
        const tx = (() => {
            try {
                const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(b.transactionBase64 as string));
                assertIsFullySignedTransaction(decoded);
                return decoded;
            } catch { throw new HttpError(400, 'InvalidTransaction', 'invalid or unsigned transaction'); }
        })();
        const hash = createHash('sha256').update(new Uint8Array(tx.messageBytes)).digest('hex');
        const row = db.prepare('SELECT wallet FROM wallet_messages WHERE hash = ? AND expires_at > ?').get(hash, now()) as { wallet: Address } | undefined;
        if (!row) throw new HttpError(409, 'UnknownTransaction', 'prepared transaction is unknown or expired');
        const sig = tx.signatures[row.wallet];
        if (!sig || !await verifySignature(await getPublicKeyFromAddress(row.wallet), sig, tx.messageBytes))
            throw new HttpError(401, 'BadSignature', 'wallet signature did not verify');
        await verifiedNetwork();
        const signature = getSignatureFromTransaction(tx);
        await chain.broadcast(getBase64EncodedWireTransaction(tx), signature);
        return c.json({ signature, commitment: 'confirmed' });
    });

    app.get('/v1/me', async c => {
        const s = requireSession(c);
        const report = await chain.eligibility(s.wallet);
        if (!report.eligible || report.participant?.address !== s.participant) {
            revokeWalletSessions(db, s.wallet, now());
            return c.json(jsonSafe({ ...report, eligible: false }));
        }
        return c.json(jsonSafe(report));
    });

    app.get('/v1/wallets/:wallet/eligibility', async c => c.json(jsonSafe(await chain.eligibility(assertAddress(c.req.param('wallet'), 'wallet')))));

    app.get('/v1/attestations/:address', async c => c.json(jsonSafe(await chain.inspectAttestation(assertAddress(c.req.param('address'), 'address')))));

    // ---------------------------------------------------------------- intents

    app.post('/v1/intents/prepare', async c => {
        const s = requireSession(c);
        const b = await body(c);
        const report = await requireEligible(c, s);
        const cfg = await chain.config();
        const target = assertAddress(b.target, 'target');
        let kind: IntentKind;
        let contents: Uint8Array;
        try {
            if (b.kind === 'trade') {
                const t = b.trade as { side: 'buy' | 'sell'; points: { price: string; quantity: string }[] };
                kind = IntentKind.Trade;
                contents = encodeTrade({ side: t?.side, points: (t?.points ?? []).map(p => ({ price: BigInt(p.price), quantity: BigInt(p.quantity) })) });
            } else if (b.kind === 'nomination') {
                kind = IntentKind.Nomination;
                contents = encodeNomination({ candidate: assertAddress((b.nomination as { candidate?: string })?.candidate, 'candidate') });
            } else throw new HttpError(400, 'BadKind', 'kind must be trade or nomination');
        } catch (e) {
            if (e instanceof PayloadError || e instanceof SyntaxError || e instanceof RangeError) throw new HttpError(400, 'MalformedPayload', (e as Error).message);
            throw e;
        }
        const chainNow = await chain.now();
        const expiry = BigInt(report.badge?.expiry ?? '0');
        const deadline = [chainNow + BigInt(MAX_INTENT_LIFETIME_SECS) - 5n, expiry].reduce((a, x) => (x < a ? x : a));
        if (deadline <= chainNow) throw new HttpError(403, 'NotEligible', 'credential expires too soon');
        const hash = payloadHash(cfg.appScope, cfg.network, kind, target, contents);
        const nonce = BigInt(report.participant!.nextIntentNonce);
        const pid = fromHex(report.participant!.participantIdHex);
        const issuer = { credential: cfg.credential, schema: cfg.schema, schemaMint: cfg.schemaMint, sasAuthority: cfg.sasAuthority };
        const ba = await badgeAddresses(issuer, pid, report.participant!.bindingVersion, s.wallet);
        const ix = await submitIntentInstruction({
            wallet: s.wallet, participantId: pid, nonce, kind, target, payloadHash: hash, deadline,
            badge: { ...issuer, attestation: ba.attestation, badgeMint: ba.badgeMint, badgeTokenAccount: ba.badgeTokenAccount },
        });
        const built = await chain.buildWalletTransaction(s.wallet, [ix]);
        rememberMessage(s.wallet, built.transactionBase64);
        db.prepare(
            `INSERT OR REPLACE INTO prepared_intents (intent, participant, wallet, nonce, kind, target, contents_hex, payload_hash, deadline, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(ix.intent, s.participant, s.wallet, nonce.toString(), kind, target, toHex(contents), toHex(hash), deadline.toString(), now());
        return c.json(jsonSafe({ intent: ix.intent, nonce, kind, target, deadline, payloadHashHex: toHex(hash), contentsHex: toHex(contents), ...built }));
    });

    /** Accepts a privileged request only after confirming the matching gated intent on chain. */
    app.post('/v1/intents/admit', async c => {
        const s = requireSession(c);
        const b = await body(c);
        const intentAddress = assertAddress(b.intent, 'intent');
        const prepared = db.prepare('SELECT * FROM prepared_intents WHERE intent = ?').get(intentAddress) as Record<string, string> | undefined;
        const contentsHex = typeof b.contentsHex === 'string' ? b.contentsHex : prepared?.contents_hex;
        if (!contentsHex) throw new HttpError(400, 'BadRequest', 'contentsHex required');
        const report = await requireEligible(c, s);
        const intent = await chain.intent(intentAddress);
        if (!intent) throw new HttpError(409, 'IntentNotConfirmed', 'intent not found at confirmed commitment');
        const cfg = await chain.config();
        const chainNow = await chain.now();
        const fail = (code: string, message: string) => {
            throw new HttpError(409, code, message);
        };
        if (b.expectedTarget !== undefined && intent.target !== assertAddress(b.expectedTarget, 'expectedTarget'))
            fail('IntentTargetMismatch', 'intent belongs to a different action or batch');
        if (b.expectedKind !== undefined && b.expectedKind !== (intent.kind === IntentKind.Trade ? 'trade' : 'nomination'))
            fail('IntentKindMismatch', 'intent has a different kind');
        if (intent.participant !== s.participant) fail('IntentOwnerMismatch', 'intent belongs to another participant');
        if (intent.wallet !== s.wallet) fail('WalletNotCurrent', 'intent was submitted by another wallet');
        if (intent.state !== IntentState.Open) fail('IntentNotOpen', 'intent is not open');
        if (intent.deadline <= chainNow) fail('IntentExpired', 'intent expired');
        if (intent.bindingVersion !== report.participant!.bindingVersion) fail('StaleIntentBinding', 'intent predates the current binding');
        let contents: Uint8Array;
        try {
            contents = fromHex(contentsHex);
            validateContents(intent.kind as IntentKind, contents);
        } catch (e) {
            throw new HttpError(400, 'MalformedPayload', (e as Error).message);
        }
        if (!bytesEqual(payloadHash(cfg.appScope, cfg.network, intent.kind as IntentKind, intent.target, contents), intent.payloadHash))
            fail('PayloadHashMismatch', 'payload does not match the on-chain hash');
        try {
            db.prepare(
                `INSERT INTO admitted_intents (intent, participant, wallet, nonce, kind, target, contents_hex, payload_hash, deadline, observed_slot, admitted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(intentAddress, s.participant, s.wallet, intent.nonce.toString(), intent.kind, intent.target, contentsHex, toHex(intent.payloadHash),
                intent.deadline.toString(), intent.slot.toString(), now());
        } catch (e) {
            if (/UNIQUE|PRIMARY/.test((e as Error).message)) fail('IntentAlreadyAdmitted', 'intent already admitted');
            throw e;
        }
        return c.json(jsonSafe({ admitted: true, intent: intentAddress, nonce: intent.nonce, kind: intent.kind, target: intent.target, observedSlot: intent.slot }), 201);
    });

    // ------------------------------------------------------------ badge metadata

    app.get('/v1/badge/metadata.json', c => {
        c.header('cache-control', 'public, max-age=300');
        return c.json(badgeMetadataJson(config.badgeOrigin));
    });
    app.get('/v1/badge/image.svg', c => {
        c.header('content-type', 'image/svg+xml');
        c.header('cache-control', 'public, max-age=86400');
        return c.body(BADGE_IMAGE_SVG);
    });
    app.get('/healthz', c => c.json({ ok: true }));

    return app;
}

export const badgeUri = (config: ServiceConfig) => `${config.badgeOrigin}/v1/badge/metadata.json`;
