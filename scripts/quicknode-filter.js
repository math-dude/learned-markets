// QuickNode Streams Solana block filter. The relayer retrieves each confirmed transaction
// from its configured RPC and decodes only events emitted inside this program invocation.
function main(stream) {
    const signatures = [];
    const prefix = 'Program nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz invoke [';
    for (const block of stream.data) {
        for (const tx of block.transactions ?? []) {
            if (tx.meta && !tx.meta.err && tx.meta.logMessages?.some(line => line.startsWith(prefix))) {
                signatures.push(tx.transaction.signatures[0]);
            }
        }
    }
    return signatures.length ? { signatures } : null;
}
