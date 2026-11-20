/**
 * Service operator commands (run on the operator machine with keys):
 *   list                         pending requests and open operations
 *   approve <requestId> [--participant-id hex] [--operator name]
 *   reject <requestId>
 *   run <operationId>            advance a resumable operation (reconciles first)
 *   show <operationId>
 *   index:sync                   rebuild the chain-derived registry index
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSolanaRpc } from '@solana/kit';
import { loadSigner, ParticipantStatusName, toHex } from '@learned-markets/attestations';
import { badgeUri } from './app.ts';
import { RpcChain } from './chain.ts';
import { loadConfig } from './config.ts';
import { openDb, transaction } from './db.ts';
import { rpcExecutor } from './executor.ts';
import { approveRequest, getOperation, rejectRequest, runOperation } from './operations.ts';

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'participant-id': { type: 'string' }, operator: { type: 'string' } },
});
const config = loadConfig();
const db = openDb(config.dbPath);
const rpc = createSolanaRpc(config.rpcUrl);
const chain = new RpcChain(rpc);
const keysDir = process.env.LM_KEYS_DIR ?? 'keys';
const print = (v: unknown) => console.log(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));

async function executor() {
    const [payer, admin, issuanceSigner, ca] = await Promise.all(
        ['payer', 'admin', 'issuance-signer', 'credential-authority'].map(n => loadSigner(join(keysDir, `${n}.json`))),
    );
    return rpcExecutor(rpc, { payer, admin, issuanceSigner, credentialAuthority: ca.address }, badgeUri(config));
}

async function main() {
    const [cmd, id] = positionals;
    const operator = values.operator ?? process.env.USER ?? 'operator';
    switch (cmd) {
        case 'list':
            return print({
                pending: db.prepare(`SELECT id, kind, wallet, replaces_wallet, created_at FROM requests WHERE status = 'pending' ORDER BY created_at`).all(),
                open: db.prepare(`SELECT id, kind, wallet, participant_id, binding_version, step, status, last_error FROM operations WHERE status <> 'completed'`).all(),
            });
        case 'approve':
            return print(await approveRequest(db, chain, id, operator, { participantIdHex: values['participant-id'] }));
        case 'reject':
            return print(rejectRequest(db, id, operator));
        case 'run':
            return print(await runOperation(db, chain, await executor(), id));
        case 'show':
            return print({
                operation: getOperation(db, id),
                transactions: db.prepare('SELECT step, signature, status, created_at FROM operation_txs WHERE operation_id = ? ORDER BY id').all(id),
            });
        case 'index:sync': {
            const { slot, participants } = await chain.listParticipants();
            transaction(db, () => {
                const up = db.prepare(
                    `INSERT INTO registry_index (participant, participant_id, current_wallet, binding_version, status, current_attestation, next_intent_nonce, observed_slot, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(participant) DO UPDATE SET current_wallet = excluded.current_wallet, binding_version = excluded.binding_version,
                       status = excluded.status, current_attestation = excluded.current_attestation, next_intent_nonce = excluded.next_intent_nonce,
                       observed_slot = excluded.observed_slot, updated_at = excluded.updated_at`,
                );
                for (const p of participants)
                    up.run(p.address, toHex(p.participantId), p.currentWallet, p.bindingVersion, ParticipantStatusName[p.status] ?? 'Unknown',
                        p.currentAttestation, p.nextIntentNonce.toString(), slot.toString(), Date.now());
            });
            return print({ slot, participants: participants.length });
        }
        default:
            console.error('usage: operator <list|approve|reject|run|show|index:sync> [id] [--participant-id hex]');
            process.exitCode = 2;
    }
}

main().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
});
