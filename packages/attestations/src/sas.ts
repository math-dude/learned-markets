import {
    findAttestationMintPda,
    findAttestationPda,
    findCredentialPda,
    findEventAuthorityPda,
    findSasAuthorityPda,
    findSchemaMintPda,
    findSchemaPda,
    getChangeSchemaStatusInstruction,
    getCloseTokenizedAttestationInstruction,
    getCreateCredentialInstruction,
    getCreateSchemaInstruction,
    getCreateTokenizedAttestationInstruction,
    getTokenizeSchemaInstruction,
    SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
} from '@solana/attestation';
import {
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    findAssociatedTokenPda,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import type { Address, TransactionSigner } from '@solana/kit';
import {
    BADGE_NAME,
    BADGE_SYMBOL,
    CREDENTIAL_NAME,
    SCHEMA_DESCRIPTION,
    SCHEMA_FIELD_NAMES,
    SCHEMA_GROUP_MAX_SIZE,
    SCHEMA_LAYOUT,
    SCHEMA_NAME,
    SCHEMA_VERSION,
} from './constants.ts';
import { attestationNonce, encodeParticipantData, type ParticipantData } from './participant-data.ts';
import { badgeMintSpace } from './metadata.ts';

export type IssuerAddresses = {
    credential: Address;
    schema: Address;
    schemaMint: Address;
    sasAuthority: Address;
};

export async function issuerAddresses(credentialAuthority: Address): Promise<IssuerAddresses> {
    const [credential] = await findCredentialPda({ authority: credentialAuthority, name: CREDENTIAL_NAME });
    const [schema] = await findSchemaPda({ credential, name: SCHEMA_NAME, version: SCHEMA_VERSION });
    const [schemaMint] = await findSchemaMintPda({ schema });
    const [sasAuthority] = await findSasAuthorityPda();
    return { credential, schema, schemaMint, sasAuthority };
}

export type BadgeAddresses = {
    nonce: Address;
    attestation: Address;
    badgeMint: Address;
    badgeTokenAccount: Address;
};

/** Deterministic addresses for (participant, binding version, wallet). */
export async function badgeAddresses(
    issuer: IssuerAddresses,
    participantId: Uint8Array,
    bindingVersion: number,
    wallet: Address,
): Promise<BadgeAddresses> {
    const nonce = attestationNonce(participantId, bindingVersion);
    const [attestation] = await findAttestationPda({ credential: issuer.credential, schema: issuer.schema, nonce });
    const [badgeMint] = await findAttestationMintPda({ attestation });
    const [badgeTokenAccount] = await findAssociatedTokenPda({
        mint: badgeMint,
        owner: wallet,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    return { nonce, attestation, badgeMint, badgeTokenAccount };
}

/** Credential with separate authority (admin of the issuer) and issuance signer. */
export function createIssuerInstructions(p: {
    payer: TransactionSigner;
    credentialAuthority: TransactionSigner;
    issuanceSigner: Address;
    issuer: IssuerAddresses;
}) {
    return [
        getCreateCredentialInstruction({
            payer: p.payer,
            credential: p.issuer.credential,
            authority: p.credentialAuthority,
            name: CREDENTIAL_NAME,
            signers: [p.issuanceSigner],
        }),
        getCreateSchemaInstruction({
            payer: p.payer,
            authority: p.credentialAuthority,
            credential: p.issuer.credential,
            schema: p.issuer.schema,
            name: SCHEMA_NAME,
            description: SCHEMA_DESCRIPTION,
            layout: [...SCHEMA_LAYOUT],
            fieldNames: [...SCHEMA_FIELD_NAMES],
        }),
        getTokenizeSchemaInstruction({
            payer: p.payer,
            authority: p.credentialAuthority,
            credential: p.issuer.credential,
            schema: p.issuer.schema,
            mint: p.issuer.schemaMint,
            sasPda: p.issuer.sasAuthority,
            maxSize: SCHEMA_GROUP_MAX_SIZE,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        }),
    ];
}

export async function createBadgeInstruction(p: {
    payer: TransactionSigner;
    issuanceSigner: TransactionSigner;
    issuer: IssuerAddresses;
    data: ParticipantData;
    expiry: bigint;
    uri: string;
}) {
    const addrs = await badgeAddresses(p.issuer, p.data.participantId, p.data.bindingVersion, p.data.wallet);
    const mintAccountSpace = badgeMintSpace({
        attestation: addrs.attestation,
        schema: p.issuer.schema,
        schemaMint: p.issuer.schemaMint,
        sasAuthority: p.issuer.sasAuthority,
        badgeMint: addrs.badgeMint,
        uri: p.uri,
    });
    const instruction = getCreateTokenizedAttestationInstruction({
        payer: p.payer,
        authority: p.issuanceSigner,
        credential: p.issuer.credential,
        schema: p.issuer.schema,
        attestation: addrs.attestation,
        schemaMint: p.issuer.schemaMint,
        attestationMint: addrs.badgeMint,
        sasPda: p.issuer.sasAuthority,
        recipientTokenAccount: addrs.badgeTokenAccount,
        recipient: p.data.wallet,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        nonce: addrs.nonce,
        data: encodeParticipantData(p.data),
        expiry: p.expiry,
        name: BADGE_NAME,
        uri: p.uri,
        symbol: BADGE_SYMBOL,
        mintAccountSpace,
    });
    return { instruction, addresses: addrs, mintAccountSpace };
}

/** Revocation: burns the badge via the SAS permanent delegate, closes mint and attestation. */
export async function revokeBadgeInstruction(p: {
    payer: TransactionSigner;
    issuanceSigner: TransactionSigner;
    issuer: IssuerAddresses;
    attestation: Address;
    badgeTokenAccount: Address;
}) {
    const [eventAuthority] = await findEventAuthorityPda();
    const [attestationMint] = await findAttestationMintPda({ attestation: p.attestation });
    return getCloseTokenizedAttestationInstruction({
        payer: p.payer,
        authority: p.issuanceSigner,
        credential: p.issuer.credential,
        attestation: p.attestation,
        eventAuthority,
        attestationProgram: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
        attestationMint,
        sasPda: p.issuer.sasAuthority,
        attestationTokenAccount: p.badgeTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
}

/** SAS schema pause; the gate treats it as admission suspended. */
export function setSchemaPausedInstruction(p: {
    credentialAuthority: TransactionSigner;
    issuer: IssuerAddresses;
    paused: boolean;
}) {
    return getChangeSchemaStatusInstruction({
        authority: p.credentialAuthority,
        credential: p.issuer.credential,
        schema: p.issuer.schema,
        isPaused: p.paused,
    });
}
