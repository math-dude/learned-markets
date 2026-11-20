import { DatabaseSync } from 'node:sqlite';
import { jsonWire } from '@learned-markets/client/settlement-v2';
import { type Address, type Signature } from '@solana/kit';
import type { ProgramEvent } from './events.ts';

export class Store {
    readonly db: DatabaseSync;
    constructor(path: string, genesis: string) {
        this.db = new DatabaseSync(path);
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS orders(intent TEXT PRIMARY KEY, market TEXT NOT NULL, slot TEXT NOT NULL, contents TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(sig TEXT NOT NULL, idx INTEGER NOT NULL, slot INTEGER NOT NULL, market TEXT NOT NULL,
                name TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(sig,idx));
            CREATE INDEX IF NOT EXISTS market_events ON events(market,name,slot);
            CREATE TABLE IF NOT EXISTS seen(market TEXT NOT NULL, account TEXT NOT NULL, PRIMARY KEY(market,account));
        `);
        this.db.prepare("INSERT OR IGNORE INTO settings VALUES('genesis',?)").run(genesis);
        if (this.get<string>('genesis', false) !== genesis) throw new Error('settler database belongs to a different genesis');
    }
    get<T>(key: string, json = true): T | null {
        const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
        return row ? (json ? JSON.parse(String(row.value)) : row.value) as T : null;
    }
    put(key: string, value: unknown) {
        this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, jsonWire(value));
    }
    order(intent: Address, market: Address, slot: bigint, hex: string) {
        this.db.prepare('INSERT OR IGNORE INTO orders VALUES(?,?,?,?)').run(intent, market, slot.toString(), hex);
    }
    orders(market: Address, start: bigint, cutoff: bigint) {
        return this.db.prepare('SELECT intent,contents,slot FROM orders WHERE market=?').all(market)
            .filter(r => BigInt(String(r.slot)) > start && BigInt(String(r.slot)) <= cutoff)
            .map(row => ({ intent: row.intent as Address, contents_hex: String(row.contents) }));
    }
    ingest(sig: Signature, slot: bigint, events: ProgramEvent[]) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)');
        this.db.exec('BEGIN');
        try {
            for (const e of events) {
                const market = e.data.market ?? e.data.target;
                if (typeof market === 'string' && ['BatchSettled','IntentSubmitted'].includes(e.name)) {
                    const data = JSON.stringify(e.data, (_, v) => typeof v === 'bigint' ? v.toString()
                        : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v);
                    insert.run(sig, e.index, slot, market, e.name, data);
                }
            }
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    events(market: Address, name?: string) {
        const rows = name ? this.db.prepare('SELECT * FROM events WHERE market=? AND name=? ORDER BY slot DESC,rowid DESC LIMIT 32').all(market,name)
            : this.db.prepare('SELECT * FROM events WHERE market=? ORDER BY slot DESC,rowid DESC LIMIT 64').all(market);
        return rows.map(r => ({ sig: r.sig, slot: String(r.slot), index: r.idx, name: r.name, data: JSON.parse(String(r.data)) }));
    }
    previousAccounts(market: Address): Address[] {
        return this.db.prepare('SELECT account FROM seen WHERE market=? ORDER BY rowid LIMIT 256').all(market).map(r => r.account as Address);
    }
    recordAccounts(market: Address, accounts: Address[]) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)');
        for (const account of accounts) insert.run(market, account);
    }
}
