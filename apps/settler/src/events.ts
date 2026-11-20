import { LEARNED_MARKETS_PROGRAM_ADDRESS } from '@learned-markets/attestations';
import * as generated from '@learned-markets/client/generated';
import { signature, type Address, type Rpc, type Signature, type SolanaRpcApi } from '@solana/kit';

export type ProgramEvent = { name: string; data: Record<string, unknown>; index: number };

export function decodeLogs(logs: readonly string[]): ProgramEvent[] {
    const stack: string[] = [];
    const events: ProgramEvent[] = [];
    const exports = generated as unknown as Record<string, (bytes: Uint8Array) => Record<string, unknown>>;
    for (const [index, line] of logs.entries()) {
        if (line === 'Log truncated') throw new Error('transaction has truncated program logs');
        const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
        if (invoke) { stack.length = Number(invoke[2]) - 1; stack.push(invoke[1]); continue; }
        if (/^Program \S+ (success|failed:)/.test(line)) { stack.pop(); continue; }
        if (stack.at(-1) !== LEARNED_MARKETS_PROGRAM_ADDRESS || !line.startsWith('Program data: ')) continue;
        const bytes = Buffer.from(line.slice('Program data: '.length), 'base64');
        const kind = generated.identifyLearnedMarketsEvent(bytes);
        const name = generated.LearnedMarketsEvent[kind];
        const data = exports['parse' + name + 'Event'](bytes);
        events.push({ index, name, data });
    }
    return events;
}

export async function transactionEvents(rpc: Rpc<SolanaRpcApi>, sig: Signature, commitment: 'confirmed' | 'finalized') {
    const tx = await rpc.getTransaction(sig, { commitment, encoding: 'json', maxSupportedTransactionVersion: 0 }).send();
    if (!tx?.meta) throw new Error('missing transaction metadata for ' + sig);
    if (tx.meta.err) return { slot: tx.slot, events: [] };
    if (!tx.meta.logMessages) throw new Error('missing event logs for ' + sig);
    return { slot: tx.slot, events: decodeLogs(tx.meta.logMessages) };
}

/** Finalized ledger order, including explicit in-block ordering for ambiguous signature pages. */
export async function* marketHistory(rpc: Rpc<SolanaRpcApi>, market: Address) {
    let before: Signature | undefined;
    const groups = new Map<bigint, Set<Signature>>();
    for (;;) {
        const page = await rpc.getSignaturesForAddress(market, { commitment: 'finalized', before, limit: 1000 }).send();
        for (const row of page) {
            if (row.err) continue;
            const group = groups.get(row.slot) ?? new Set<Signature>();
            group.add(row.signature);
            groups.set(row.slot, group);
        }
        if (page.length < 1000) break;
        before = page[page.length - 1].signature;
    }
    const slots = [...groups.keys()].sort((a, b) => a < b ? -1 : 1);
    for (const slot of slots) {
        const group = groups.get(slot)!;
        let ordered = [...group];
        if (ordered.length > 1) {
            const block = await rpc.getBlock(slot, { transactionDetails: 'signatures', commitment: 'finalized', rewards: false,
                maxSupportedTransactionVersion: 0 }).send();
            if (!block) throw new Error('missing block ' + slot);
            ordered = block.signatures.map(s => signature(s)).filter(sig => group.has(sig));
            if (ordered.length !== group.size) throw new Error('incomplete block history at ' + slot);
        }
        for (const sig of ordered) {
            const { events } = await transactionEvents(rpc, sig, 'finalized');
            for (const event of events) if (event.data.market === market) yield { ...event, slot, signature: sig };
        }
    }
}
