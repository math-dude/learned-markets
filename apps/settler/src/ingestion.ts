import { createSolanaRpcSubscriptions, signature, type Address, type Rpc, type Signature, type SolanaRpcApi } from '@solana/kit';
import { LEARNED_MARKETS_PROGRAM_ADDRESS as program } from '@learned-markets/attestations';
import { decodeLogs, transactionEvents } from './events.ts';
import type { Store } from './store.ts';

export async function backfill(rpc: Rpc<SolanaRpcApi>, store: Store, start: bigint) {
    const cursor = store.get<string>('events-cursor');
    let before: Signature | undefined, latest: Signature | undefined;
    const rows: { signature: Signature; slot: bigint }[] = [];
    let done = false;
    while (!done) {
        const page = await rpc.getSignaturesForAddress(program, { commitment: 'finalized', before, limit: 1000 }).send();
        latest ??= page[0]?.signature;
        for (const row of page) {
            if (row.signature === cursor || row.slot < start) { done = true; break; }
            if (!row.err) rows.push(row);
        }
        if (!page.length || page.length < 1000) break;
        before = page.at(-1)!.signature;
    }
    for (const row of rows.reverse()) {
        const { events } = await transactionEvents(rpc, row.signature, 'finalized');
        store.ingest(row.signature, row.slot, events);
    }
    if (latest) store.put('events-cursor', latest);
}

export async function followRpc(rpcUrl: string, rpc: Rpc<SolanaRpcApi>, store: Store, earliestMarketSlot: bigint,
    signal: AbortSignal) {
    const url = new URL(rpcUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (url.port === '8899') url.port = '8900';
    const subs = createSolanaRpcSubscriptions(process.env.LM_WS_URL ?? url.href);
    while (!signal.aborted) {
        const connection = new AbortController();
        const stop = () => connection.abort();
        signal.addEventListener('abort', stop, { once: true });
        // Periodic reconnect reconciles silent drops as well as explicit disconnects.
        const timer = setTimeout(stop, 60_000);
        try {
            const feed = await subs.logsNotifications({ mentions: [program] }, { commitment: 'finalized' })
                .subscribe({ abortSignal: connection.signal });
            const live = (async () => {
                for await (const { context, value } of feed) if (!value.err) {
                    store.ingest(signature(value.signature), context.slot, decodeLogs(value.logs));
                }
            })();
            // Attach both handlers immediately so a disconnect while backfilling cannot
            // turn into an unhandled rejection. The next pass resumes at the durable cursor.
            await Promise.all([live, backfill(rpc, store, earliestMarketSlot)]);
        } catch (e) {
            if (!connection.signal.aborted) console.error('RPC event feed:', (e as Error).message);
        } finally {
            connection.abort(); clearTimeout(timer); signal.removeEventListener('abort', stop);
        }
        if (!signal.aborted) await new Promise(r => setTimeout(r, 1000));
    }
}
