/**
 * Enrollment / replacement lifecycle with resumable, reconciled operations.
 *
 * Invariants:
 *  - Every transaction's signature and intended addresses are persisted before submission.
 *  - A submitted-but-unconfirmed transaction is reconciled before anything is retried.
 *  - Each step first probes the chain for its effect, so re-running is idempotent
 *    (no duplicate issuance; SAS addresses are deterministic per binding version).
 *  - Failures leave the participant suspended/ineligible; the old binding is never restored.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token-2022';
import {
    badgeAddresses,
    ConfirmationTimeoutError,
    findWalletBindingPda,
    fromHex,
    ParticipantStatus,
    toHex,
    TOKEN_2022_PROGRAM_ADDRESS,
    type SignatureOutcome,
    type SubmittedTx,
} from '@learned-markets/attestations';
import { HttpError } from './auth.ts';
import type { Chain } from './chain.ts';
import { transaction, type Db } from './db.ts';

export type OperationKind = 'enroll' | 'replace';
export type OperationRow = {
    id: string;
    kind: OperationKind;
    request_id: string;
    participant_id: string;
    wallet: string;
    previous_wallet: string | null;
    previous_attestation: string | null;
    previous_token_account: string | null;
    binding_version: number;
    intended_attestation: string;
    intended_badge_mint: string;
    intended_token_account: string;
    step: string;
    status: 'in_progress' | 'awaiting_participant' | 'needs_reconcile' | 'failed' | 'completed';
    prepared_tx: string | null;
    participant_signed_tx: string | null;
    last_error: string | null;
};

export const STEPS: Record<OperationKind, string[]> = {
    enroll: ['issue', 'await_registration', 'verify', 'done'],
    replace: ['suspend', 'revoke_old', 'issue', 'await_replacement_signature', 'cosign', 'verify', 'done'],
};

/** Signing side of operations; implemented only by operator tooling. */
export interface OperatorExecutor {
    suspend(participantId: Uint8Array, beforeSend: (tx: SubmittedTx) => void): Promise<SubmittedTx>;
    revokeBadge(attestation: Address, tokenAccount: Address, beforeSend: (tx: SubmittedTx) => void): Promise<SubmittedTx>;
    issueBadge(p: { participantId: Uint8Array; wallet: Address; bindingVersion: number }, beforeSend: (tx: SubmittedTx) => void): Promise<SubmittedTx>;
    /** Adds operator payer + admin signatures to a wallet-signed replacement and submits it. */
    cosignAndSubmit(walletSignedTxBase64: string, beforeSend: (tx: SubmittedTx) => void): Promise<SubmittedTx>;
    reconcile(tx: SubmittedTx): Promise<SignatureOutcome>;
}

// ------------------------------------------------------------------ requests

export function createRequest(db: Db, kind: OperationKind, wallet: Address, replacesWallet: Address | null, challengeId: string, signature: string, now = Date.now()) {
    const id = randomUUID();
    try {
        db.prepare(
            `INSERT INTO requests (id, kind, wallet, replaces_wallet, challenge_id, signature, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(id, kind, wallet, replacesWallet, challengeId, signature, now);
    } catch (e) {
        if (/UNIQUE/.test((e as Error).message)) throw new HttpError(409, 'RequestPending', 'a request for this wallet is already pending');
        throw e;
    }
    return { requestId: id, status: 'pending' as const };
}

export function getRequest(db: Db, id: string) {
    const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const op = db.prepare('SELECT id, step, status, last_error, binding_version, intended_attestation FROM operations WHERE request_id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
    return {
        requestId: r.id, kind: r.kind, wallet: r.wallet, replacesWallet: r.replaces_wallet, status: r.status,
        participantIdHex: r.participant_id,
        operation: op ? { id: op.id, step: op.step, status: op.status, lastError: op.last_error, bindingVersion: op.binding_version, intendedAttestation: op.intended_attestation } : null,
    };
}

export function rejectRequest(db: Db, requestId: string, operator: string, now = Date.now()) {
    const res = db.prepare(`UPDATE requests SET status = 'rejected', approved_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`).run(operator, now, requestId);
    if (res.changes !== 1) throw new HttpError(409, 'NotPending', 'request is not pending');
}

/**
 * Operator approval. Reads the chain first, then atomically flips the request
 * and creates its operation. Concurrent approvals of the same request, or two
 * open operations for one participant, fail on the status check / unique index.
 */
export async function approveRequest(db: Db, chain: Chain, requestId: string, operator: string, opts: { participantIdHex?: string } = {}, now = Date.now()) {
    const req = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId) as
        | { id: string; kind: OperationKind; wallet: string; replaces_wallet: string | null; status: string }
        | undefined;
    if (!req) throw new HttpError(404, 'UnknownRequest', 'request not found');
    if (req.status !== 'pending') throw new HttpError(409, 'NotPending', `request is ${req.status}`);
    const config = await chain.config();
    const issuer = { credential: config.credential, schema: config.schema, schemaMint: config.schemaMint, sasAuthority: config.sasAuthority };
    const wallet = req.wallet as Address;

    let participantId: Uint8Array;
    let bindingVersion: number;
    let previous: { wallet: Address; attestation: Address; tokenAccount: Address } | null = null;

    if (req.kind === 'enroll') {
        participantId = opts.participantIdHex ? fromHex(opts.participantIdHex) : new Uint8Array(randomBytes(32));
        if (participantId.length !== 32) throw new HttpError(400, 'BadParticipantId', 'participant id must be 32 bytes');
        if (await chain.participantById(participantId))
            throw new HttpError(409, 'ParticipantExists', 'participant already registered; use a replacement request');
        if (await chain.accountExists(await findWalletBindingPda(wallet)))
            throw new HttpError(409, 'WalletAlreadyBound', 'wallet is (or was) bound to a participant');
        bindingVersion = 1;
    } else {
        const replaces = req.replaces_wallet as Address;
        const row = db.prepare('SELECT participant_id FROM registry_index WHERE current_wallet = ?').get(replaces) as { participant_id: string } | undefined;
        const pidHex = opts.participantIdHex ?? row?.participant_id;
        if (!pidHex) throw new HttpError(409, 'UnknownParticipant', 'replaced wallet not in registry index; pass --participant-id');
        participantId = fromHex(pidHex);
        const p = await chain.participantById(participantId);
        if (!p) throw new HttpError(409, 'UnknownParticipant', 'participant not registered on chain');
        if (p.currentWallet !== replaces) throw new HttpError(409, 'StaleReplacement', 'replaced wallet is not the current binding');
        if (p.status === ParticipantStatus.Revoked) throw new HttpError(409, 'ParticipantRevoked', 'participant is revoked');
        // A new wallet with an existing binding is allowed only if it is a retired binding
        // of this same participant; replace_binding enforces that on chain.
        bindingVersion = p.bindingVersion + 1;
        const [tokenAccount] = await findAssociatedTokenPda({ mint: p.currentBadgeMint, owner: p.currentWallet, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
        previous = { wallet: p.currentWallet, attestation: p.currentAttestation, tokenAccount };
    }

    const intended = await badgeAddresses(issuer, participantId, bindingVersion, wallet);
    const opId = randomUUID();
    try {
        transaction(db, () => {
            const res = db.prepare(`UPDATE requests SET status = 'approved', participant_id = ?, approved_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
                .run(toHex(participantId), operator, now, requestId);
            if (res.changes !== 1) throw new HttpError(409, 'NotPending', 'request was decided concurrently');
            db.prepare(
                `INSERT INTO operations (id, kind, request_id, participant_id, wallet, previous_wallet, previous_attestation, previous_token_account,
                    binding_version, intended_attestation, intended_badge_mint, intended_token_account, step, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
            ).run(
                opId, req.kind, requestId, toHex(participantId), wallet, previous?.wallet ?? null, previous?.attestation ?? null,
                previous?.tokenAccount ?? null, bindingVersion, intended.attestation, intended.badgeMint, intended.badgeTokenAccount,
                STEPS[req.kind][0], now, now,
            );
        });
    } catch (e) {
        if (e instanceof HttpError) throw e;
        if (/UNIQUE/.test((e as Error).message)) throw new HttpError(409, 'OperationInProgress', 'participant already has an open operation');
        throw e;
    }
    return { operationId: opId, participantIdHex: toHex(participantId), bindingVersion, intended };
}

// ---------------------------------------------------------------- operations

export function getOperation(db: Db, id: string): OperationRow {
    const op = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined;
    if (!op) throw new HttpError(404, 'UnknownOperation', 'operation not found');
    return op;
}

function update(db: Db, id: string, fields: Partial<OperationRow>) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE operations SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map(k => (fields as Record<string, string | number | null>)[k]), Date.now(), id);
}

function recordTx(db: Db, opId: string, step: string, tx: SubmittedTx) {
    db.prepare(`INSERT INTO operation_txs (operation_id, step, signature, last_valid_block_height, status, created_at) VALUES (?, ?, ?, ?, 'submitted', ?)`)
        .run(opId, step, tx.signature, tx.lastValidBlockHeight.toString(), Date.now());
}

function lastTx(db: Db, opId: string, step: string) {
    return db.prepare(`SELECT * FROM operation_txs WHERE operation_id = ? AND step = ? ORDER BY id DESC LIMIT 1`).get(opId, step) as
        | { id: number; signature: string; last_valid_block_height: string; status: string }
        | undefined;
}

function setTxStatus(db: Db, id: number, status: string) {
    db.prepare('UPDATE operation_txs SET status = ? WHERE id = ?').run(status, id);
}

type StepResult = 'done' | 'waiting' | 'failed' | 'skip_to_verify';

async function txStep(
    db: Db,
    exec: OperatorExecutor | null,
    op: OperationRow,
    probe: () => Promise<boolean>,
    submit: (beforeSend: (tx: SubmittedTx) => void) => Promise<SubmittedTx>,
): Promise<StepResult> {
    if (await probe()) return 'done';
    if (!exec) return 'waiting';
    const last = lastTx(db, op.id, op.step);
    if (last && last.status === 'submitted') {
        const outcome = await exec.reconcile({ signature: last.signature as never, lastValidBlockHeight: BigInt(last.last_valid_block_height) });
        if (outcome === 'confirmed') {
            setTxStatus(db, last.id, 'confirmed');
            return 'done';
        }
        if (outcome === 'pending') {
            update(db, op.id, { status: 'needs_reconcile' });
            return 'waiting';
        }
        setTxStatus(db, last.id, outcome);
        if (await probe()) return 'done';
    }
    try {
        const tx = await submit(t => recordTx(db, op.id, op.step, t));
        const row = lastTx(db, op.id, op.step);
        if (row && row.signature === tx.signature) setTxStatus(db, row.id, 'confirmed');
        return 'done';
    } catch (e) {
        if (e instanceof ConfirmationTimeoutError) {
            update(db, op.id, { status: 'needs_reconcile', last_error: e.message });
            return 'waiting';
        }
        const row = lastTx(db, op.id, op.step);
        if (row && row.status === 'submitted') {
            // Unknown whether it landed: keep it for reconciliation on the next run.
            update(db, op.id, { status: 'needs_reconcile', last_error: (e as Error).message });
            return 'waiting';
        }
        update(db, op.id, { status: 'failed', last_error: (e as Error).message });
        return 'failed';
    }
}

/**
 * Advances an operation as far as possible. With `exec = null` (the HTTP
 * service, which holds no keys) only keyless steps (awaiting the participant,
 * verification) can progress.
 */
export async function runOperation(db: Db, chain: Chain, exec: OperatorExecutor | null, opId: string): Promise<OperationRow> {
    for (let guard = 0; guard < 16; guard++) {
        const op = getOperation(db, opId);
        if (op.status === 'completed') return op;
        const pid = fromHex(op.participant_id);
        const wallet = op.wallet as Address;
        const replacedOnChain = async () => {
            const p = await chain.participantById(pid);
            return !!p && p.bindingVersion >= op.binding_version && p.currentAttestation === op.intended_attestation;
        };

        let result: StepResult;
        switch (op.step) {
            case 'suspend':
                result = (await replacedOnChain())
                    ? 'skip_to_verify'
                    : await txStep(db, exec, op, async () => (await chain.participantById(pid))?.status !== ParticipantStatus.Active, b => exec!.suspend(pid, b));
                break;
            case 'revoke_old':
                result = await txStep(
                    db, exec, op,
                    async () => !op.previous_attestation || !(await chain.accountExists(op.previous_attestation as Address)),
                    b => exec!.revokeBadge(op.previous_attestation as Address, op.previous_token_account as Address, b),
                );
                break;
            case 'issue':
                result = await txStep(
                    db, exec, op,
                    () => chain.accountExists(op.intended_attestation as Address),
                    b => exec!.issueBadge({ participantId: pid, wallet, bindingVersion: op.binding_version }, b),
                );
                break;
            case 'await_registration': {
                const p = await chain.participantById(pid);
                result = p && p.currentAttestation === op.intended_attestation ? 'done' : 'waiting';
                if (result === 'waiting') update(db, op.id, { status: 'awaiting_participant' });
                break;
            }
            case 'await_replacement_signature':
                if (await replacedOnChain()) result = 'skip_to_verify';
                else if (op.participant_signed_tx) result = 'done';
                else {
                    update(db, op.id, { status: 'awaiting_participant' });
                    result = 'waiting';
                }
                break;
            case 'cosign': {
                if (await replacedOnChain()) {
                    result = 'skip_to_verify';
                    break;
                }
                const signed = op.participant_signed_tx;
                if (!signed) {
                    update(db, op.id, { step: 'await_replacement_signature', status: 'awaiting_participant' });
                    continue;
                }
                result = await txStep(db, exec, op, replacedOnChain, b => exec!.cosignAndSubmit(signed, b));
                const last = lastTx(db, op.id, 'cosign');
                if (result === 'failed' || last?.status === 'expired') {
                    // Blockhash lapsed or rejected: the wallet must sign a fresh transaction.
                    update(db, op.id, { step: 'await_replacement_signature', status: 'awaiting_participant', participant_signed_tx: null, prepared_tx: null });
                    return getOperation(db, opId);
                }
                break;
            }
            case 'verify': {
                const report = await chain.eligibility(wallet);
                if (report.eligible) result = 'done';
                else {
                    update(db, op.id, { status: 'failed', last_error: `not eligible: ${report.reasons.map(r => r.code).join(',')}` });
                    result = 'failed';
                }
                break;
            }
            default:
                result = 'done';
        }

        if (result === 'waiting' || result === 'failed') return getOperation(db, opId);
        const steps = STEPS[op.kind];
        const next = result === 'skip_to_verify' ? 'verify' : steps[steps.indexOf(op.step) + 1];
        update(db, op.id, next === 'done' ? { step: 'done', status: 'completed', last_error: null } : { step: next, status: 'in_progress', last_error: null });
    }
    return getOperation(db, opId);
}
