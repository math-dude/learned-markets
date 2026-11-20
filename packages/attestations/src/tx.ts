import {
    appendTransactionMessageInstructions,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    partiallySignTransactionMessageWithSigners,
    type Address,
    type Instruction,
    type Rpc,
    type Signature,
    type SolanaRpcApi,
    type TransactionSigner,
} from '@solana/kit';

export type SubmittedTx = { signature: Signature; lastValidBlockHeight: bigint };

export class ConfirmationTimeoutError extends Error {
    readonly signature: Signature;
    readonly lastValidBlockHeight: bigint;
    constructor(tx: SubmittedTx) {
        super(`transaction ${tx.signature} not confirmed before block height ${tx.lastValidBlockHeight}`);
        this.signature = tx.signature;
        this.lastValidBlockHeight = tx.lastValidBlockHeight;
    }
}

export class TransactionFailedError extends Error {
    readonly signature: Signature;
    constructor(signature: Signature, err: unknown) {
        super(`transaction ${signature} failed: ${JSON.stringify(err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
        this.signature = signature;
    }
}

export type SignatureOutcome = 'confirmed' | 'failed' | 'pending' | 'expired';

/** Reconciles a previously submitted signature (e.g. after a timeout or crash). */
export async function reconcileSignature(rpc: Rpc<SolanaRpcApi>, tx: SubmittedTx): Promise<SignatureOutcome> {
    const { value } = await rpc.getSignatureStatuses([tx.signature], { searchTransactionHistory: true }).send();
    const status = value[0];
    if (status) {
        if (status.err) return 'failed';
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return 'confirmed';
        return 'pending';
    }
    const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
    return height > tx.lastValidBlockHeight ? 'expired' : 'pending';
}

/**
 * Signs, records the signature via `beforeSend` (persist it BEFORE submission),
 * submits, and waits for `confirmed`. Throws ConfirmationTimeoutError when the
 * blockhash expires without a status; callers must reconcile before retrying.
 */
export async function sendAndConfirm(p: {
    rpc: Rpc<SolanaRpcApi>;
    feePayer: TransactionSigner;
    instructions: Instruction[];
    beforeSend?: (tx: SubmittedTx) => void | Promise<void>;
    pollMs?: number;
}): Promise<SubmittedTx> {
    const { value: blockhash } = await p.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(p.feePayer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        m => appendTransactionMessageInstructions(p.instructions, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const tx: SubmittedTx = {
        signature: getSignatureFromTransaction(signed),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
    await p.beforeSend?.(tx);
    await p.rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send();
    for (;;) {
        const outcome = await reconcileSignature(p.rpc, tx);
        if (outcome === 'confirmed') return tx;
        if (outcome === 'failed') {
            const { value } = await p.rpc.getSignatureStatuses([tx.signature]).send();
            throw new TransactionFailedError(tx.signature, value[0]?.err);
        }
        if (outcome === 'expired') throw new ConfirmationTimeoutError(tx);
        await new Promise(r => setTimeout(r, p.pollMs ?? 800));
    }
}

/**
 * Builds a transaction for a wallet to sign client-side. Optional `signers`
 * (e.g. the admin for replace_binding) add their signatures first.
 * Returns base64 wire bytes with empty slots for the remaining signers.
 */
export async function buildTransactionForWallet(p: {
    rpc: Rpc<SolanaRpcApi>;
    feePayer: Address;
    instructions: Instruction[];
}): Promise<{ transactionBase64: string; lastValidBlockHeight: bigint }> {
    const { value: blockhash } = await p.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayer(p.feePayer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        m => appendTransactionMessageInstructions(p.instructions, m),
    );
    const hasSigners = p.instructions.some(i => (i.accounts ?? []).some(a => 'signer' in a));
    const tx = hasSigners ? await partiallySignTransactionMessageWithSigners(message) : compileTransaction(message);
    return { transactionBase64: getBase64EncodedWireTransaction(tx), lastValidBlockHeight: blockhash.lastValidBlockHeight };
}

export { createNoopSigner };
