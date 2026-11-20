/**
 * Read-only chain access for the service. All reads use `confirmed`
 * commitment and are never cached as positive authorization.
 */
import {
    getBase64Encoder,
    type Base64EncodedWireTransaction,
    type Signature,
    type Address,
    type Instruction,
    type Rpc,
    type SolanaRpcApi,
} from '@solana/kit';
import {
    buildTransactionForWallet,
    chainNow,
    checkEligibility,
    decodeConfig,
    decodeIntent,
    decodeParticipant,
    findConfigPda,
    findParticipantPda,
    inspectAttestation,
    LEARNED_MARKETS_PROGRAM_ADDRESS,
    accountDiscriminator,
    RpcUnavailableError,
    type EligibilityReport,
    type GateConfig,
    type IntentAccount,
    type ParticipantAccount,
} from '@learned-markets/attestations';

export type ParticipantRecord = ParticipantAccount & { address: Address };

export interface Chain {
    /** Full eligibility (registry + badge) at confirmed commitment. Throws RpcUnavailableError. */
    genesisHash(): Promise<string>;
    broadcast(wire: Base64EncodedWireTransaction, expected: Signature): Promise<void>;
    eligibility(wallet: Address): Promise<EligibilityReport>;
    inspectAttestation(attestation: Address): Promise<unknown>;
    config(): Promise<GateConfig>;
    participantById(participantId: Uint8Array): Promise<ParticipantRecord | null>;
    intent(address: Address): Promise<(IntentAccount & { slot: bigint }) | null>;
    accountExists(address: Address): Promise<boolean>;
    now(): Promise<bigint>;
    buildWalletTransaction(feePayer: Address, instructions: Instruction[]): Promise<{ transactionBase64: string; lastValidBlockHeight: bigint }>;
    listParticipants(): Promise<{ slot: bigint; participants: ParticipantRecord[] }>;
}

async function guarded<T>(f: () => Promise<T>): Promise<T> {
    try {
        return await f();
    } catch (e) {
        if (e instanceof RpcUnavailableError) throw e;
        if (e instanceof Error && /fetch|ECONN|network|timeout|HTTP error|429|503/i.test(e.message)) throw new RpcUnavailableError(e);
        throw e;
    }
}

export class RpcChain implements Chain {
    private readonly rpc: Rpc<SolanaRpcApi>;
    constructor(rpc: Rpc<SolanaRpcApi>) {
        this.rpc = rpc;
    }

    private async account(address: Address) {
        const { context, value } = await this.rpc.getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' }).send();
        return value ? { slot: context.slot, owner: value.owner, data: new Uint8Array(getBase64Encoder().encode(value.data[0])) } : null;
    }

    genesisHash() {
        return guarded(() => this.rpc.getGenesisHash().send());
    }

    async broadcast(wire: Base64EncodedWireTransaction, expected: Signature) {
        const signature = await guarded(() => this.rpc.sendTransaction(wire, {
            encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0n,
        }).send());
        if (signature !== expected) throw new Error('RPC signature mismatch');
        for (let attempt = 0; attempt < 45; attempt++) {
            const status = (await guarded(() => this.rpc.getSignatureStatuses([signature]).send())).value[0];
            if (status?.err) throw new Error('Solana rejected transaction ' + signature);
            if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
            await new Promise(resolve => setTimeout(resolve, 600));
        }
        throw new RpcUnavailableError(new Error('Confirmation pending for ' + signature));
    }

    eligibility(wallet: Address) {
        return guarded(() => checkEligibility(this.rpc, wallet));
    }
    inspectAttestation(attestation: Address) {
        return guarded(() => inspectAttestation(this.rpc, attestation));
    }
    config() {
        return guarded(async () => {
            const a = await this.account(await findConfigPda());
            if (!a) throw new Error('registry config not initialized');
            return decodeConfig(a.data);
        });
    }
    participantById(participantId: Uint8Array) {
        return guarded(async () => {
            const address = await findParticipantPda(participantId);
            const a = await this.account(address);
            return a && a.owner === LEARNED_MARKETS_PROGRAM_ADDRESS ? { ...decodeParticipant(a.data), address } : null;
        });
    }
    intent(address: Address) {
        return guarded(async () => {
            const a = await this.account(address);
            return a && a.owner === LEARNED_MARKETS_PROGRAM_ADDRESS ? { ...decodeIntent(a.data), slot: a.slot } : null;
        });
    }
    accountExists(address: Address) {
        return guarded(async () => (await this.account(address)) !== null);
    }
    now() {
        return guarded(() => chainNow(this.rpc));
    }
    buildWalletTransaction(feePayer: Address, instructions: Instruction[]) {
        return guarded(() => buildTransactionForWallet({ rpc: this.rpc, feePayer, instructions }));
    }
    listParticipants() {
        return guarded(async () => {
            const disc = Buffer.from(accountDiscriminator('Participant')).toString('base64');
            const res = await this.rpc
                .getProgramAccounts(LEARNED_MARKETS_PROGRAM_ADDRESS, {
                    commitment: 'confirmed',
                    encoding: 'base64',
                    withContext: true,
                    filters: [{ memcmp: { offset: 0n, bytes: disc as never, encoding: 'base64' } }],
                })
                .send();
            const b64 = getBase64Encoder();
            return {
                slot: res.context.slot,
                participants: res.value.map(v => ({ ...decodeParticipant(new Uint8Array(b64.encode(v.account.data[0]))), address: v.pubkey })),
            };
        });
    }
}
