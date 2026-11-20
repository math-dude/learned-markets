/** Operator-side executor: the only component that loads signing keys. */
import {
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
    partiallySignTransaction,
    type Address,
    type KeyPairSigner,
    type Rpc,
    type SolanaRpcApi,
    type Transaction,
} from '@solana/kit';
import {
    ConfirmationTimeoutError,
    issueBadge,
    issuerAddresses,
    reconcileSignature,
    revokeBadge,
    suspendParticipant,
    TransactionFailedError,
    type SubmittedTx,
} from '@learned-markets/attestations';
import type { OperatorExecutor } from './operations.ts';

export type ExecutorKeys = {
    payer: KeyPairSigner;
    admin: KeyPairSigner;
    issuanceSigner: KeyPairSigner;
    credentialAuthority: Address;
};

export function rpcExecutor(rpc: Rpc<SolanaRpcApi>, keys: ExecutorKeys, badgeUri: string): OperatorExecutor {
    const issuer = issuerAddresses(keys.credentialAuthority);
    return {
        suspend: (pid, beforeSend) => suspendParticipant(rpc, keys, pid, beforeSend),
        revokeBadge: async (attestation, tokenAccount, beforeSend) =>
            revokeBadge(rpc, keys, await issuer, { attestation, badgeTokenAccount: tokenAccount, beforeSend }),
        issueBadge: async (p, beforeSend) => issueBadge(rpc, keys, await issuer, { ...p, uri: badgeUri, beforeSend }),
        reconcile: tx => reconcileSignature(rpc, tx),
        async cosignAndSubmit(signedBase64, beforeSend) {
            const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(signedBase64)) as Transaction;
            const tx = await partiallySignTransaction([keys.payer.keyPair, keys.admin.keyPair], decoded);
            const { value: height } = { value: await rpc.getBlockHeight({ commitment: 'confirmed' }).send() };
            // The blockhash in the message bounds validity; ~150 blocks is the protocol limit.
            const submitted: SubmittedTx = { signature: getSignatureFromTransaction(tx), lastValidBlockHeight: height + 150n };
            beforeSend(submitted);
            await rpc.sendTransaction(getBase64EncodedWireTransaction(tx as never), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
            for (;;) {
                const outcome = await reconcileSignature(rpc, submitted);
                if (outcome === 'confirmed') return submitted;
                if (outcome === 'failed') throw new TransactionFailedError(submitted.signature, 'replace_binding failed');
                if (outcome === 'expired') throw new ConfirmationTimeoutError(submitted);
                await new Promise(r => setTimeout(r, 800));
            }
        },
    };
}
