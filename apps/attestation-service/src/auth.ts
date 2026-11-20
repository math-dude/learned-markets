import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    getBase58Encoder,
    getPublicKeyFromAddress,
    isAddress,
    verifySignature,
    type Address,
    type SignatureBytes,
} from '@solana/kit';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from './config.ts';
import { transaction, type Db } from './db.ts';

export type ChallengeAction = 'enroll' | 'replace' | 'session';
export const ACTIONS: readonly ChallengeAction[] = ['enroll', 'replace', 'session'];

export class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details?: unknown;
    constructor(status: number, code: string, message: string, details?: unknown) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

export function assertAddress(v: unknown, field: string): Address {
    if (typeof v !== 'string' || !isAddress(v)) throw new HttpError(400, 'InvalidAddress', `${field} must be a base58 address`);
    return v;
}

/** Exact text the wallet signs; binds origin, wallet, action, nonce and expiry. */
export function challengeMessage(p: { origin: string; wallet: Address; action: ChallengeAction; nonce: string; issuedAt: Date; expiresAt: Date; replacesWallet?: Address | null }) {
    const lines = [
        `${new URL(p.origin).host} wants you to sign with your Solana account:`,
        p.wallet,
        '',
        `Action: learned-markets:${p.action}`,
        `Origin: ${p.origin}`,
        `Nonce: ${p.nonce}`,
        `Issued At: ${p.issuedAt.toISOString()}`,
        `Expiration Time: ${p.expiresAt.toISOString()}`,
    ];
    if (p.replacesWallet) lines.push(`Replaces Wallet: ${p.replacesWallet}`);
    return lines.join('\n');
}

export function createChallenge(db: Db, origin: string, wallet: Address, action: ChallengeAction, replacesWallet: Address | null, now = Date.now()) {
    if (action === 'replace' && !replacesWallet) throw new HttpError(400, 'MissingReplacesWallet', 'replace challenges must name the wallet being replaced');
    if (action !== 'replace' && replacesWallet) throw new HttpError(400, 'UnexpectedReplacesWallet', 'only replace challenges name a previous wallet');
    const id = randomUUID();
    const expiresAt = now + CHALLENGE_TTL_MS;
    const message = challengeMessage({
        origin, wallet, action, nonce: randomBytes(16).toString('hex'),
        issuedAt: new Date(now), expiresAt: new Date(expiresAt), replacesWallet,
    });
    db.prepare('INSERT INTO challenges (id, wallet, action, message, replaces_wallet, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, wallet, action, message, replacesWallet, expiresAt, now);
    return { challengeId: id, message, expiresAt: new Date(expiresAt).toISOString() };
}

type ChallengeRow = { id: string; wallet: string; action: string; message: string; replaces_wallet: string | null; expires_at: number; used_at: number | null };

/**
 * Verifies a signed challenge and consumes it exactly once. The signature must
 * cover the stored message (origin/wallet/action/nonce/expiry) verbatim.
 */
export async function consumeChallenge(db: Db, challengeId: unknown, signature: unknown, action: ChallengeAction, now = Date.now()) {
    if (typeof challengeId !== 'string' || typeof signature !== 'string') throw new HttpError(400, 'BadRequest', 'challengeId and signature are required');
    const row = db.prepare('SELECT * FROM challenges WHERE id = ?').get(challengeId) as ChallengeRow | undefined;
    if (!row) throw new HttpError(401, 'UnknownChallenge', 'challenge not found');
    if (row.action !== action) throw new HttpError(401, 'WrongAction', `challenge is for ${row.action}`);
    if (row.used_at !== null) throw new HttpError(401, 'ChallengeReplayed', 'challenge already used');
    if (now >= row.expires_at) throw new HttpError(401, 'ChallengeExpired', 'challenge expired');

    let sigBytes: Uint8Array;
    try {
        sigBytes = new Uint8Array(getBase58Encoder().encode(signature));
    } catch {
        throw new HttpError(401, 'BadSignature', 'signature must be base58');
    }
    if (sigBytes.length !== 64) throw new HttpError(401, 'BadSignature', 'signature must be 64 bytes');
    const key = await getPublicKeyFromAddress(row.wallet as Address);
    const ok = await verifySignature(key, sigBytes as SignatureBytes, new TextEncoder().encode(row.message));
    if (!ok) throw new HttpError(401, 'BadSignature', 'signature does not match the challenge');

    // Atomic single use (guards concurrent submissions of the same challenge).
    const res = db.prepare('UPDATE challenges SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, challengeId);
    if (res.changes !== 1) throw new HttpError(401, 'ChallengeReplayed', 'challenge already used');
    return { wallet: row.wallet as Address, replacesWallet: row.replaces_wallet as Address | null, challengeId };
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(db: Db, wallet: Address, participant: Address, now = Date.now()) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_TTL_MS;
    transaction(db, () => {
        // One live session per wallet.
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE wallet = ? AND revoked_at IS NULL').run(now, wallet);
        db.prepare('INSERT INTO sessions (token_hash, wallet, participant, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(hashToken(token), wallet, participant, expiresAt, now);
    });
    return { token, expiresAt };
}

export type Session = { tokenHash: string; wallet: Address; participant: Address; expiresAt: number };

export function getSession(db: Db, token: string | undefined, now = Date.now()): Session | null {
    if (!token) return null;
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
        | { token_hash: string; wallet: string; participant: string; expires_at: number; revoked_at: number | null }
        | undefined;
    if (!row || row.revoked_at !== null || now >= row.expires_at) return null;
    return { tokenHash: row.token_hash, wallet: row.wallet as Address, participant: row.participant as Address, expiresAt: row.expires_at };
}

export function revokeSession(db: Db, tokenHash: string, now = Date.now()) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now, tokenHash);
}

export function revokeWalletSessions(db: Db, wallet: Address, now = Date.now()) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE wallet = ? AND revoked_at IS NULL').run(now, wallet);
}
