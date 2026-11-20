import { getAttestationDataCodec, type Schema } from '@solana/attestation';
import type { Address } from '@solana/kit';
import {
    APP_SCOPE,
    ATTESTATION_NONCE_DOMAIN,
    SCHEMA_DESCRIPTION,
    SCHEMA_FIELD_NAMES,
    SCHEMA_LAYOUT,
    SCHEMA_NAME,
    SCHEMA_VERSION,
    VERIFICATION_METHOD_OPERATOR_APPROVED,
} from './constants.ts';
import { addressBytes, bytesToAddress, sha256, u32le, utf8 } from './bytes.ts';

/** Decoded `learned-markets-participant` v1 attestation payload. */
export type ParticipantData = {
    appScope: string;
    /** 32 random bytes, stable across wallet changes. */
    participantId: Uint8Array;
    wallet: Address;
    verificationMethod: number;
    bindingVersion: number;
    /** Unix seconds. */
    issuedAt: bigint;
};

/** Shape of the on-chain schema, enough for the SAS data codec. */
const SCHEMA_SHAPE = {
    discriminator: 1,
    name: SCHEMA_NAME,
    description: SCHEMA_DESCRIPTION,
    layout: [...SCHEMA_LAYOUT],
    fieldNames: [...SCHEMA_FIELD_NAMES],
    isPaused: false,
    version: SCHEMA_VERSION,
} as unknown as Schema;

type RawData = {
    app_scope: string;
    participant_id: number[];
    wallet: number[];
    verification_method: number;
    binding_version: number;
    issued_at: bigint;
};

const codec = () => getAttestationDataCodec(SCHEMA_SHAPE);

export class ParticipantDataError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

/** Semantic restrictions beyond SAS type validation. Throws ParticipantDataError. */
export function validateParticipantData(d: ParticipantData): void {
    if (d.appScope !== APP_SCOPE) throw new ParticipantDataError('WrongAppScope', `app_scope must be ${APP_SCOPE}`);
    if (d.participantId.length !== 32)
        throw new ParticipantDataError('MalformedAttestationData', 'participant_id must be 32 bytes');
    if (d.verificationMethod !== VERIFICATION_METHOD_OPERATOR_APPROVED)
        throw new ParticipantDataError('UnsupportedVerificationMethod', `unsupported method ${d.verificationMethod}`);
    if (!Number.isInteger(d.bindingVersion) || d.bindingVersion < 1 || d.bindingVersion > 0xffffffff)
        throw new ParticipantDataError('BindingVersionMismatch', 'binding_version must be a u32 >= 1');
}

export function encodeParticipantData(d: ParticipantData): Uint8Array {
    validateParticipantData(d);
    const raw: RawData = {
        app_scope: d.appScope,
        participant_id: Array.from(d.participantId),
        wallet: Array.from(addressBytes(d.wallet)),
        verification_method: d.verificationMethod,
        binding_version: d.bindingVersion,
        issued_at: d.issuedAt,
    };
    return new Uint8Array(codec().encode(raw));
}

/** Decodes with the pinned SAS codec, then enforces exact lengths and full consumption. */
export function decodeParticipantData(bytes: Uint8Array): ParticipantData {
    let raw: RawData;
    let offset: number;
    try {
        [raw, offset] = codec().read(bytes, 0) as unknown as [RawData, number];
    } catch {
        throw new ParticipantDataError('MalformedAttestationData', 'attestation data does not match the schema layout');
    }
    if (offset !== bytes.length) throw new ParticipantDataError('MalformedAttestationData', 'trailing bytes');
    if (raw.participant_id.length !== 32 || raw.wallet.length !== 32)
        throw new ParticipantDataError('MalformedAttestationData', 'participant_id and wallet must be 32 bytes');
    return {
        appScope: raw.app_scope,
        participantId: Uint8Array.from(raw.participant_id),
        wallet: bytesToAddress(Uint8Array.from(raw.wallet)),
        verificationMethod: raw.verification_method,
        bindingVersion: raw.binding_version,
        issuedAt: BigInt(raw.issued_at),
    };
}

/**
 * Deterministic SAS attestation nonce: sha256(domain || participant_id || binding_version_le).
 * Same derivation as `sas::attestation_nonce` in the program.
 */
export function attestationNonce(participantId: Uint8Array, bindingVersion: number): Address {
    if (participantId.length !== 32) throw new Error('participant_id must be 32 bytes');
    return bytesToAddress(sha256(utf8.encode(ATTESTATION_NONCE_DOMAIN), participantId, u32le(bindingVersion)));
}

/** Validity window rules shared with `sas::check_validity_window`. Returns a reason code or null. */
export function validityWindowError(issuedAt: bigint, expiry: bigint, now: bigint): string | null {
    if (expiry === 0n) return 'NonExpiringAttestation';
    if (now >= expiry) return 'AttestationExpired';
    if (issuedAt > now + 30n) return 'AttestationIssuedInFuture';
    if (issuedAt >= expiry || expiry - issuedAt > 7n * 86_400n) return 'AttestationLifetimeTooLong';
    return null;
}
