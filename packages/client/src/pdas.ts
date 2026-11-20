import { getProgramDerivedAddress, type Address } from '@solana/kit';
import { addressBytes, LEARNED_MARKETS_PROGRAM_ADDRESS, u64le, utf8 } from '@learned-markets/attestations';

function pda(name: string, ...seeds: Uint8Array[]) {
    return getProgramDerivedAddress({ programAddress: LEARNED_MARKETS_PROGRAM_ADDRESS, seeds: [utf8.encode(name), ...seeds] });
}
function idSeed(id: bigint) {
    if (id < 0n || id >= (1n << 64n)) throw new RangeError('id exceeds u64');
    return u64le(id);
}
export const boardPda = () => pda('board');
export const mintPda = (deployerParticipant: Address, marketsCreated: bigint) =>
    pda('mint', addressBytes(deployerParticipant), idSeed(marketsCreated));
export const marketPda = (baseMint: Address) => pda('market', addressBytes(baseMint));
export const vaultPda = (market: Address, mint: Address) => pda('vault', addressBytes(market), addressBytes(mint));
export const positionPda = (market: Address, participant: Address) => pda('position', addressBytes(market), addressBytes(participant));
export const batchPda = (market: Address, batchId: bigint) => pda('batch', addressBytes(market), idSeed(batchId));
