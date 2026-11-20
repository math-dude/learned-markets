/**
 * Resumable, throttled program-buffer upload for flaky public RPCs.
 * Reads the existing buffer, rewrites only chunks that differ from the .so, then exits.
 *
 *   node scripts/resume-buffer-write.ts <buffer-pubkey> <program.so> [authority-keypair]
 * Then: solana program deploy -u devnet --buffer <buffer-pubkey> --program-id <program-keypair> ...
 */
import { readFile } from 'node:fs/promises';
import {
    address,
    appendTransactionMessageInstructions,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    AccountRole,
    type Instruction,
} from '@solana/kit';
import { loadSigner, rpcFor } from '@learned-markets/attestations';

const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const HEADER = 37; // UpgradeableLoaderState::Buffer { authority: Option<Pubkey> }
const CHUNK = 950;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

const [bufferArg, soPath, authPath = 'keys/deployer.json'] = process.argv.slice(2);
const rpc = rpcFor(process.env.LM_RPC_URL ?? 'https://api.devnet.solana.com');
const buffer = address(bufferArg);
const authority = await loadSigner(authPath);
const program = new Uint8Array(await readFile(soPath));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function retry<T>(f: () => Promise<T>, tries = 8): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return await f();
        } catch (e) {
            if (i >= tries) throw e;
            await sleep(1000 * 2 ** Math.min(i, 4));
        }
    }
}

async function missingChunks(): Promise<number[]> {
    const { value } = await retry(() => rpc.getAccountInfo(buffer, { encoding: 'base64', commitment: 'confirmed' }).send());
    if (!value) throw new Error('buffer account not found');
    const data = Buffer.from(value.data[0], 'base64');
    if (data.length - HEADER < program.length) throw new Error(`buffer too small: ${data.length - HEADER} < ${program.length}`);
    const out: number[] = [];
    for (let off = 0; off < program.length; off += CHUNK) {
        const end = Math.min(off + CHUNK, program.length);
        if (!data.subarray(HEADER + off, HEADER + end).equals(Buffer.from(program.subarray(off, end)))) out.push(off);
    }
    return out;
}

function writeIx(offset: number): Instruction {
    const bytes = program.subarray(offset, Math.min(offset + CHUNK, program.length));
    const d = new Uint8Array(4 + 4 + 8 + bytes.length);
    const v = new DataView(d.buffer);
    v.setUint32(0, 1, true); // Write
    v.setUint32(4, offset, true);
    v.setBigUint64(8, BigInt(bytes.length), true);
    d.set(bytes, 16);
    return {
        programAddress: LOADER,
        accounts: [
            { address: buffer, role: AccountRole.WRITABLE },
            { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority } as never,
        ],
        data: d,
    };
}

for (let round = 1; round <= 20; round++) {
    const todo = await missingChunks();
    console.log(`round ${round}: ${todo.length} of ${Math.ceil(program.length / CHUNK)} chunks missing`);
    if (todo.length === 0) {
        console.log('BUFFER-COMPLETE');
        process.exit(0);
    }
    const { value: bh } = await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
    const sigs: string[] = [];
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
        await Promise.all(todo.slice(i, i + CONCURRENCY).map(async off => {
            const tx = await signTransactionMessageWithSigners(pipe(
                createTransactionMessage({ version: 0 }),
                m => setTransactionMessageFeePayerSigner(authority, m),
                m => setTransactionMessageLifetimeUsingBlockhash(bh, m),
                m => appendTransactionMessageInstructions([writeIx(off)], m),
            ));
            sigs.push(getSignatureFromTransaction(tx));
            await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', skipPreflight: true, maxRetries: 5n }).send().catch(() => {});
        }));
        await sleep(350);
    }
    await sleep(15_000); // let them land before re-checking
}
console.error('gave up after 20 rounds');
process.exit(1);
