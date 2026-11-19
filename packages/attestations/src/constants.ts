import { address } from '@solana/kit';
import { SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from '@solana/attestation';
import { TOKEN_2022_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token-2022';

export { SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS as SAS_PROGRAM_ADDRESS };
export { TOKEN_2022_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS };

/** learned-markets gate program (programs/learned-markets). */
export const LEARNED_MARKETS_PROGRAM_ADDRESS = address('nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz');

export const APP_SCOPE = 'learned-markets:demo';

export const CREDENTIAL_NAME = 'Learned Markets Demo Issuer';
export const SCHEMA_NAME = 'learned-markets-participant';
export const SCHEMA_VERSION = 1;
export const SCHEMA_DESCRIPTION = 'Binds an operator-approved Learned Markets test participant to one wallet';
/** String, VecU8, VecU8, U8, U32, I64 — same order in Rust (`SCHEMA_LAYOUT`). */
export const SCHEMA_LAYOUT: readonly number[] = [12, 13, 13, 0, 2, 8];
export const SCHEMA_FIELD_NAMES: readonly string[] = [
    'app_scope',
    'participant_id',
    'wallet',
    'verification_method',
    'binding_version',
    'issued_at',
];
/** Lifetime issuance capacity of the schema group, including replacements and renewals. */
export const SCHEMA_GROUP_MAX_SIZE = 1_000_000n;

export const VERIFICATION_METHOD_OPERATOR_APPROVED = 0;

export const BADGE_NAME = 'Learned Markets Demo Pass';
export const BADGE_SYMBOL = 'LMTEST';

export const DEFAULT_ATTESTATION_LIFETIME_SECS = 7 * 24 * 60 * 60;
export const MAX_ATTESTATION_LIFETIME_SECS = 7 * 24 * 60 * 60;
export const MAX_ISSUED_AT_FUTURE_SKEW_SECS = 30;
export const MAX_INTENT_LIFETIME_SECS = 5 * 60;

export const ATTESTATION_NONCE_DOMAIN = 'learned-markets:attestation-nonce:v1';
export const INTENT_PAYLOAD_DOMAIN = 'learned-markets:intent-payload';
export const INTENT_PAYLOAD_VERSION = 1;

export const SAS_DISCRIMINATOR = { credential: 0, schema: 1, attestation: 2 } as const;
