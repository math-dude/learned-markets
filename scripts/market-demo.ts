import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { address, getProgramDerivedAddress, lamports, type Address, type KeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction,
    getMintToCheckedInstruction, getMintSize, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { addressBytes, evaluateEligibility, fetchEligibilitySnapshot, findConfigPda, generateKeypairFile,
    LEARNED_MARKETS_PROGRAM_ADDRESS as program, loadSigner, rpcFor, sendAndConfirm } from '@learned-markets/attestations';
import { boardPda, marketPda, mintPda, positionPda, vaultPda } from '@learned-markets/client/settlement-v2';
import { fetchBoardConfig, fetchMarket, fetchMaybePosition, getCreateMarketInstruction,
    getDepositQuoteInstruction, getInitializeBoardInstruction } from '@learned-markets/client/generated';
import { Client, enroll } from './two-user-client-demo.ts';

export const network = process.env.LM_NETWORK ?? 'surfpool';
const rpcUrl = process.env.LM_RPC_URL;
if (!rpcUrl || !['localnet','surfpool','devnet'].includes(network)) throw new Error('set LM_RPC_URL and LM_NETWORK for a demo cluster');
export const rpc = rpcFor(rpcUrl);
const keysDir = 'keys/market-demo/' + network;
const getKey = async (name: string) => {
    const path = keysDir + '/' + name + '.json';
    try { await generateKeypairFile(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    return loadSigner(path);
};

export async function demoClient(name: string, payer: KeyPairSigner) {
    const wallet = await getKey(name);
    const balance = await rpc.getBalance(wallet.address, { commitment: 'confirmed' }).send();
    const target = 50_000_000n;
    if (balance.value < target) await sendAndConfirm({ rpc, feePayer: payer,
        instructions: [getTransferSolInstruction({ source: payer, destination: wallet.address, amount: lamports(target - balance.value) })] });
    const client = new Client(name, wallet);
    const snapshot = await fetchEligibilitySnapshot(rpc, wallet.address);
    if (!snapshot.participant) await enroll(client);
    else {
        if (!evaluateEligibility(snapshot).eligible) throw new Error(name + ' requires restored Admission standing');
        const challenge = await client.signedChallenge('session');
        await client.ok('POST', '/v1/sessions', { challengeId: challenge.challengeId, signature: challenge.signature });
    }
    return client;
}

async function gate(wallet: KeyPairSigner) {
    const s = await fetchEligibilitySnapshot(rpc, wallet.address);
    if (!evaluateEligibility(s).eligible || !s.participant || !s.config || !s.badge?.badgeTokenAccount || !s.binding) {
        throw new Error('demo wallet is ineligible: ' + wallet.address);
    }
    return { wallet, config: await findConfigPda(), participant: s.participant.address, walletBinding: s.binding.address,
        credential: s.config.credential, schema: s.config.schema, schemaMint: s.config.schemaMint,
        attestation: s.participant.currentAttestation, badgeMint: s.participant.currentBadgeMint,
        badgeTokenAccount: s.badge.badgeTokenAccount.address };
}

async function quoteTokens(payer: KeyPairSigner, mint: Address, owner: Address, needed: bigint) {
    const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const info = await rpc.getAccountInfo(ata, { encoding: 'base64', commitment: 'confirmed' }).send();
    const balance = info.value ? BigInt((await rpc.getTokenAccountBalance(ata, {commitment:'confirmed'}).send()).value.amount) : 0n;
    if (!info.value || balance < needed) {
        const instructions = [getCreateAssociatedTokenIdempotentInstruction({ payer, mint, owner, ata, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })];
        await sendAndConfirm({ rpc, feePayer: payer, instructions: [...instructions, ...(balance < needed ?
            [getMintToCheckedInstruction({ mint, token: ata, mintAuthority: payer, amount: needed - balance, decimals: 6 })] : [])] });
    }
    return ata;
}

export async function fundPosition(market: Address, wallet: KeyPairSigner, payer: KeyPairSigner, target: bigint) {
    const m = (await fetchMarket(rpc, market)).data;
    const user = await gate(wallet), [position] = await positionPda(market, user.participant);
    const p = await fetchMaybePosition(rpc, position);
    if (p.exists && p.data.quote >= target) return;
    const amount = target - (p.exists ? p.data.quote : 0n);
    const ata = await quoteTokens(payer, m.quoteMint, wallet.address, amount);
    await sendAndConfirm({ rpc, feePayer: payer, instructions: [getDepositQuoteInstruction({ ...user, tokenAuthority: wallet,
        sourceBinding: user.walletBinding, market, position, mint: m.quoteMint, vault: m.quoteVault,
        walletToken: ata, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount })] });
}

async function main() {
    const payer = await loadSigner('keys/payer.json');
    const authority = await loadSigner('keys/deployer.json');
    const quoter = await loadSigner(process.env.LM_QUOTER_KEY ?? 'keys/settlement-authority.json');
    const admin = await loadSigner('keys/admin.json');
    const mint = await getKey('tusd');
    if (!(await rpc.getAccountInfo(mint.address, { encoding:'base64',commitment:'confirmed' }).send()).value) {
        const space = BigInt(getMintSize());
        const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
        await sendAndConfirm({ rpc, feePayer: payer, instructions: [
            getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
            getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: payer.address }),
        ] });
    }
    const [board] = await boardPda();
    if (!(await rpc.getAccountInfo(board, { encoding:'base64',commitment:'confirmed' }).send()).value) {
        const [programData] = await getProgramDerivedAddress({ programAddress: address('BPFLoaderUpgradeab1e11111111111111111111111'),
            seeds: [addressBytes(program)] });
        await sendAndConfirm({ rpc, feePayer: payer, instructions: [getInitializeBoardInstruction({
            authority, program, programData, board, auctionAuthority: admin.address, boardAuthority: admin.address,
            treasury: payer.address, launchQuoteMint: mint.address, launchFee: 1_000_000n, launchFeeMakerShareBps: 7500, lineOpen: true })] });
    }
    const b = (await fetchBoardConfig(rpc, board)).data;
    if (b.launchQuoteMint !== mint.address) throw new Error('existing board uses another quote mint');
    const deployer = await demoClient('deployer', payer), user = await gate(deployer.wallet);
    const genesis = await rpc.getGenesisHash().send();
    const stateFile = keysDir + '/market-' + genesis + '.json';
    let state: { market: Address; baseMint: Address };
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const [baseMint] = await mintPda(user.participant, b.marketsCreated);
        const [market] = await marketPda(baseMint);
        state = { market, baseMint };
        await mkdir(keysDir, { recursive: true });
        await writeFile(stateFile, JSON.stringify(state), {flag:'wx'});
    }
    const { market, baseMint } = state;
    const [baseVault] = await vaultPda(market, baseMint), [quoteVault] = await vaultPda(market, mint.address);
    if (!(await rpc.getAccountInfo(market, { encoding:'base64',commitment:'confirmed' }).send()).value) {
        const walletQuote = await quoteTokens(payer, mint.address, deployer.wallet.address, b.launchFee);
        await sendAndConfirm({ rpc, feePayer: deployer.wallet, instructions: [getCreateMarketInstruction({
            ...user, board, baseMint, quoteMint: mint.address, market, baseVault, quoteVault, walletQuote,
            quoteProgram: TOKEN_2022_PROGRAM_ADDRESS, name: 'Demo Coin', symbol: 'DEMO', uri: '',
            totalSupply: 1_000_000_000_000n, openPrice: 1_000_000n, batchLenSlots: Number(process.env.DEMO_BATCH_SLOTS ?? 75),
            bounds: { maxTotalFeeBps: 2000, maxHoldSecs: 604800, minCapBps: 50, maxCapBps: 200,
                rookieMaxCapBps: 150, maxPerPersonBatchMax: 20_000_000_000n }, limits: { maxNetSellPerBatch: 40_000_000_000n,
                maxNetBuyPerBatch: 40_000_000_000n, maxPriceMoveBps: 3000, rookieMaxPriceMoveBps: 5000 },
            deployerFeeBps: 200, platformFeeShareBps: 5000, quoter: quoter.address })] });
    }
    console.log(JSON.stringify({ network, genesis, program, board, market, baseMint, baseVault, quoteMint: mint.address, quoteVault }));
}
if (import.meta.main) await main();
