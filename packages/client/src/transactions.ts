import {
    appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables,
    createTransactionMessage, getTransactionMessageSize, getTransactionMessageSizeLimit,
    setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
    type Address, type AddressesByLookupTableAddress, type BlockhashLifetimeConstraint, type Instruction,
    type Rpc, type SolanaRpcApi, type TransactionSigner,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { fetchAddressLookupTable, findAddressLookupTablePda, getCreateLookupTableInstruction,
    getExtendLookupTableInstruction, ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS } from '@solana-program/address-lookup-table';

export function settlementMessage(instructions: Instruction[], payer: TransactionSigner,
    lifetime: BlockhashLifetimeConstraint, tables: AddressesByLookupTableAddress) {
    const base = setTransactionMessageFeePayerSigner(payer, createTransactionMessage({ version: 0 }));
    const withLifetime = setTransactionMessageLifetimeUsingBlockhash(lifetime, base);
    const budget = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
    const message = appendTransactionMessageInstructions([budget, ...instructions], withLifetime);
    return compressTransactionMessageUsingAddressLookupTables(message, tables);
}

export type SettlementPart = { instructions: Instruction[]; fills: number; begins: boolean; finalizes: boolean };

export function buildSettlementTxs<T extends { participant: Address }>(batch: {
    payer: TransactionSigner; lifetime: BlockhashLifetimeConstraint; tables: AddressesByLookupTableAddress;
    begin?: Instruction; chunk: (items: T[]) => Instruction; finalize: Instruction;
}, fills: T[]): SettlementPart[] {
    // Canonical fill order is fixed by the clearing service. Always extend the current
    // transaction to the longest encodable prefix before starting another one.
    const parts: SettlementPart[] = [];
    let part = blank();
    function blank(): SettlementPart { return { instructions: [], fills: 0, begins: false, finalizes: false }; }
    function flush() {
        if (part.instructions.length === 0) throw new Error('one settlement instruction exceeds transaction limits');
        parts.push(part);
        part = blank();
    }
    function fits(instruction: Instruction) {
        const ixs = [...part.instructions, instruction];
        const keys = new Set<Address>([batch.payer.address]);
        for (const ix of ixs) {
            keys.add(ix.programAddress);
            for (const account of ix.accounts ?? []) keys.add(account.address);
        }
        // One additional account is the compute budget program.
        if (keys.size + 1 > 64) return false;
        const message = settlementMessage(ixs, batch.payer, batch.lifetime, batch.tables);
        return getTransactionMessageSize(message) <= getTransactionMessageSizeLimit(message);
    }
    if (batch.begin) {
        if (!fits(batch.begin)) throw new Error('begin settlement exceeds transaction limits');
        part.instructions.push(batch.begin);
        part.begins = true;
    }
    for (let offset = 0; offset < fills.length;) {
        const items: T[] = [];
        const participants = new Set<Address>();
        for (const fill of fills.slice(offset, offset + 6)) {
            if (participants.has(fill.participant) || !fits(batch.chunk([...items, fill]))) break;
            participants.add(fill.participant);
            items.push(fill);
        }
        if (items.length === 0) { flush(); continue; }
        part.instructions.push(batch.chunk(items));
        part.fills += items.length;
        offset += items.length;
    }
    if (!fits(batch.finalize)) flush();
    if (!fits(batch.finalize)) throw new Error('finalize settlement exceeds transaction limits');
    part.instructions.push(batch.finalize);
    part.finalizes = true;
    flush();
    return parts;
}

type TableOptions = {
    rpc: Rpc<SolanaRpcApi>; payer: TransactionSigner; address?: Address;
    staticAccounts: Address[]; previouslySeenAccounts: Address[];
    send: (instructions: Instruction[]) => Promise<void>;
    // Persist before submission, so restarts can recover the same address and slot.
    record: (address: Address, recentSlot: bigint) => void;
    recentSlot?: bigint;
};
export async function ensureMarketTable(options: TableOptions): Promise<AddressesByLookupTableAddress> {
    const { rpc, payer } = options;
    let table = options.address;
    if (!table || !((await rpc.getAccountInfo(table, { encoding: 'base64', commitment: 'confirmed' }).send()).value)) {
        const recentSlot = options.recentSlot ?? await rpc.getSlot({ commitment: 'finalized' }).send();
        const [address, bump] = await findAddressLookupTablePda({ authority: payer.address, recentSlot });
        if (table && address !== table) throw new Error('lookup table address and recorded creation slot disagree');
        table = address;
        options.record(table, recentSlot);
        await options.send([getCreateLookupTableInstruction({ address, authority: payer.address, payer, recentSlot, bump })]);
    }
    const read = () => fetchAddressLookupTable(rpc, table, { commitment: 'confirmed' });
    let account = await read();
    if (account.programAddress !== ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS ||
        account.data.authority.__option !== 'Some' || account.data.authority.value !== payer.address ||
        account.data.deactivationSlot !== (1n << 64n) - 1n) throw new Error('unusable market lookup table');
    const existing = new Set(account.data.addresses);
    const wanted = [...new Set([...options.staticAccounts, ...options.previouslySeenAccounts])].filter(a => !existing.has(a));
    // The Solana table index is one byte. New addresses beyond capacity travel inline.
    const additions = wanted.slice(0, 256 - existing.size);
    for (let i = 0; i < additions.length; i += 20) {
        await options.send([getExtendLookupTableInstruction({ address: table, authority: payer, payer,
            addresses: additions.slice(i, i + 20) })]);
    }
    if (additions.length) account = await read();
    while (await rpc.getSlot({ commitment: 'confirmed' }).send() <= account.data.lastExtendedSlot) {
        await new Promise(r => setTimeout(r, 300));
    }
    return { [table]: account.data.addresses };
}
