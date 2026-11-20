// Enroll the dedicated Surfpool population wallets through the participant service.
// Usage: node scripts/enroll-population.ts COUNT [START]. Each wallet is funded with test SOL,
// enrolled via the operator workflow when new, and printed as one JSON line.
import assert from 'node:assert/strict';
import { loadSigner } from '@learned-markets/attestations';
import { demoClient } from './market-demo.ts';

assert.equal(process.env.LM_NETWORK, 'surfpool');
const count = Number(process.argv[2] ?? 48);
const start = Number(process.argv[3] ?? 0);
assert.ok(Number.isInteger(count) && count > 0 && count <= 1000 && Number.isInteger(start) && start >= 0);
const payer = await loadSigner('keys/payer.json');
for (let i = start; i < start + count; i++) {
    const name = 'population-' + String(i).padStart(2, '0');
    for (let attempt = 0; ; attempt++) {
        try {
            const client = await demoClient(name, payer);
            console.log(JSON.stringify({ event: 'enrolled', name, wallet: client.wallet.address }));
            break;
        } catch (error) {
            if (attempt >= 3) throw error;
            console.error(name, (error as Error).message);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}
