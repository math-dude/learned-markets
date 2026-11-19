import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
    `
    CREATE TABLE challenges (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        replaces_wallet TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('enroll', 'replace')),
        wallet TEXT NOT NULL,
        replaces_wallet TEXT,
        challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id),
        signature TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        participant_id TEXT,
        approved_by TEXT,
        decided_at INTEGER,
        created_at INTEGER NOT NULL
    );
    -- At most one undecided request per wallet and kind.
    CREATE UNIQUE INDEX requests_one_pending ON requests(wallet, kind) WHERE status = 'pending';

    CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('enroll', 'replace')),
        request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
        participant_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        previous_wallet TEXT,
        previous_attestation TEXT,
        previous_token_account TEXT,
        binding_version INTEGER NOT NULL,
        intended_attestation TEXT NOT NULL,
        intended_badge_mint TEXT NOT NULL,
        intended_token_account TEXT NOT NULL,
        step TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in_progress', 'awaiting_participant', 'needs_reconcile', 'failed', 'completed')),
        prepared_tx TEXT,
        participant_signed_tx TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    -- One open operation per participant: serializes approvals and prevents duplicate issuance.
    CREATE UNIQUE INDEX operations_one_open ON operations(participant_id) WHERE status <> 'completed';
    CREATE UNIQUE INDEX operations_attestation ON operations(intended_attestation);

    CREATE TABLE operation_txs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL REFERENCES operations(id),
        step TEXT NOT NULL,
        signature TEXT NOT NULL UNIQUE,
        last_valid_block_height TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed', 'expired')),
        created_at INTEGER NOT NULL
    );

    CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        participant TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
    );

    -- Chain-derived, non-authoritative index (the on-chain registry is authoritative).
    CREATE TABLE registry_index (
        participant TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL UNIQUE,
        current_wallet TEXT NOT NULL,
        binding_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        current_attestation TEXT NOT NULL,
        next_intent_nonce TEXT NOT NULL,
        observed_slot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX registry_index_wallet ON registry_index(current_wallet);

    CREATE TABLE prepared_intents (
        intent TEXT PRIMARY KEY,
        participant TEXT NOT NULL,
        wallet TEXT NOT NULL,
        nonce TEXT NOT NULL,
        kind INTEGER NOT NULL,
        target TEXT NOT NULL,
        contents_hex TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        deadline TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE admitted_intents (
        intent TEXT PRIMARY KEY,
        participant TEXT NOT NULL,
        wallet TEXT NOT NULL,
        nonce TEXT NOT NULL,
        kind INTEGER NOT NULL,
        target TEXT NOT NULL,
        contents_hex TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        deadline TEXT NOT NULL,
        observed_slot TEXT NOT NULL,
        admitted_at INTEGER NOT NULL
    );
    `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    for (let v = (row.v ?? 0) + 1; v <= MIGRATIONS.length; v++) {
        transaction(db, () => {
            db.exec(MIGRATIONS[v - 1]);
            db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(v);
        });
    }
    return db;
}

/** BEGIN IMMEDIATE: serializes writers so check-then-write sequences are atomic. */
export function transaction<T>(db: Db, fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
        const out = fn();
        db.exec('COMMIT');
        return out;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}
