/**
 * Off-chain verifier mirroring `gate::verify_badge` / `gate::require_eligible`.
 *
 * Used by the service for status reporting and pre-flight. It is advisory: the
 * on-chain guard is authoritative and runs inside every protected instruction.
 * Reason codes match the program's `GateError` names.
 */
import { decodeAttestation, decodeCredential, decodeSchema } from '@solana/attestation';
import {
    getBase64Encoder,
    type Address,
    type Base64EncodedDataResponse,
    type Rpc,
    type SolanaRpcApi,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token-2022';
import { getSysvarClockDecoder, SYSVAR_CLOCK_ADDRESS } from '@solana/sysvars';
import {
    SAS_DISCRIMINATOR,
    SCHEMA_LAYOUT,
    TOKEN_2022_PROGRAM_ADDRESS,
    LEARNED_MARKETS_PROGRAM_ADDRESS,
} from './constants.ts';
import { toHex } from './bytes.ts';
import {
    decodeConfig,
    decodeParticipant,
    decodeWalletBinding,
    findConfigPda,
    findParticipantPda,
    findWalletBindingPda,
    ParticipantStatus,
    ParticipantStatusName,
    type GateConfig,
    type ParticipantAccount,
    type WalletBindingAccount,
} from './gate-accounts.ts';
import {
    attestationNonce,
    decodeParticipantData,
    ParticipantDataError,
    validityWindowError,
    type ParticipantData,
} from './participant-data.ts';
import { parseBadgeMint, parseTokenAccount } from './token2022.ts';

export type RawAccount = { address: Address; owner: Address; data: Uint8Array };
export type Reason = { code: string; message: string };
export type GateMode = 'admission' | 'standing';

export type BadgeAccounts = {
    credential: RawAccount | null;
    schema: RawAccount | null;
    schemaMint: Address;
    attestation: RawAccount | null;
    badgeMint: RawAccount | null;
    badgeTokenAccount: RawAccount | null;
};

export type BadgeCheck = {
    valid: boolean;
    reasons: Reason[];
    data: ParticipantData | null;
    expiry: bigint | null;
};

function bytesEq(a: readonly number[] | Uint8Array, b: readonly number[]): boolean {
    return a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
}

/** Mirrors `gate::verify_badge`. Collects every failing reason it can determine. */
export function checkBadge(
    config: GateConfig,
    accounts: BadgeAccounts,
    expectedWallet: Address,
    now: bigint,
    mode: GateMode,
): BadgeCheck {
    const reasons: Reason[] = [];
    const fail = (code: string, message: string) => reasons.push({ code, message });
    let data: ParticipantData | null = null;
    let expiry: bigint | null = null;

    const { credential, schema, attestation, badgeMint, badgeTokenAccount } = accounts;

    let authorizedSigners: readonly Address[] = [];
    if (!credential) fail('UntrustedCredential', 'credential account missing');
    else if (credential.address !== config.credential) fail('UntrustedCredential', 'not the trusted credential');
    else if (credential.owner !== config.sasProgram) fail('SasWrongOwner', 'credential not owned by SAS');
    else if (credential.data[0] !== SAS_DISCRIMINATOR.credential) fail('SasMalformedAccount', 'credential discriminator');
    else {
        const c = decodeCredential({ ...rawToEncoded(credential) }).data;
        if (c.authority !== config.credentialAuthority) fail('UntrustedCredentialAuthority', 'credential authority mismatch');
        authorizedSigners = c.authorizedSigners;
    }

    if (!schema) fail('UntrustedSchema', 'schema account missing');
    else if (schema.address !== config.schema) fail('UntrustedSchema', 'not the trusted schema');
    else if (schema.owner !== config.sasProgram) fail('SasWrongOwner', 'schema not owned by SAS');
    else if (schema.data[0] !== SAS_DISCRIMINATOR.schema) fail('SasMalformedAccount', 'schema discriminator');
    else {
        const s = decodeSchema({ ...rawToEncoded(schema) }).data;
        if (s.credential !== config.credential) fail('UntrustedSchema', 'schema credential mismatch');
        if (s.version !== config.schemaVersion) fail('SchemaVersionMismatch', `schema version ${s.version}`);
        if (!bytesEq(s.layout as number[], SCHEMA_LAYOUT)) fail('SchemaLayoutMismatch', 'schema layout mismatch');
        if (mode === 'admission' && s.isPaused) fail('AdmissionSuspended', 'SAS schema is paused');
    }
    if (mode === 'admission' && config.admissionPaused) fail('AdmissionSuspended', 'registry admission is paused');
    if (accounts.schemaMint !== config.schemaMint) fail('BadgeNotInSchemaGroup', 'schema mint mismatch');

    let tokenAccountAddress: Address | null = null;
    if (!attestation) fail('SasWrongOwner', 'attestation account missing (revoked or never issued)');
    else if (attestation.owner !== config.sasProgram) fail('SasWrongOwner', 'attestation not owned by SAS');
    else if (attestation.data[0] !== SAS_DISCRIMINATOR.attestation) fail('SasMalformedAccount', 'attestation discriminator');
    else {
        const a = decodeAttestation({ ...rawToEncoded(attestation) }).data;
        tokenAccountAddress = a.tokenAccount;
        expiry = a.expiry;
        if (a.credential !== config.credential) fail('UntrustedCredential', 'attestation credential mismatch');
        if (a.schema !== config.schema) fail('UntrustedSchema', 'attestation schema mismatch');
        if (!authorizedSigners.includes(a.signer)) fail('UnauthorizedAttestationSigner', 'signer not currently authorized');
        try {
            data = decodeParticipantData(new Uint8Array(a.data));
            if (data.appScope !== config.appScope) fail('WrongAppScope', `app_scope ${data.appScope}`);
            if (data.verificationMethod !== config.allowedVerificationMethod)
                fail('UnsupportedVerificationMethod', `verification_method ${data.verificationMethod}`);
            if (data.bindingVersion < 1) fail('BindingVersionMismatch', 'binding_version must be >= 1');
            if (data.wallet !== expectedWallet) fail('WalletMismatch', 'attested wallet differs');
            if (a.nonce !== attestationNonce(data.participantId, data.bindingVersion))
                fail('NonCanonicalAttestation', 'nonce is not derived from participant and version');
            const w = validityWindowError(data.issuedAt, a.expiry, now);
            if (w) fail(w, `issued_at=${data.issuedAt} expiry=${a.expiry} now=${now}`);
        } catch (e) {
            fail(e instanceof ParticipantDataError ? e.code : 'MalformedAttestationData', (e as Error).message);
        }
    }

    if (!badgeMint) fail('NonCanonicalBadgeMint', 'badge mint missing');
    else if (badgeMint.owner !== TOKEN_2022_PROGRAM_ADDRESS) fail('BadgeWrongTokenProgram', 'badge mint not Token-2022');
    else {
        try {
            const m = parseBadgeMint(badgeMint.data);
            if (!m.nonTransferable) fail('BadgeTransferable', 'mint is transferable');
            if (m.mintAuthority !== config.sasAuthority) fail('BadgeWrongMintAuthority', 'mint authority is not SAS');
            if (m.decimals !== 0 || m.supply !== 1n) fail('BadgeWrongSupply', `decimals=${m.decimals} supply=${m.supply}`);
            if (!m.groupMember || m.groupMember.mint !== badgeMint.address || m.groupMember.group !== config.schemaMint)
                fail('BadgeNotInSchemaGroup', 'mint is not a member of the schema group');
        } catch {
            fail('MalformedBadgeMint', 'badge mint is malformed');
        }
    }

    if (!badgeTokenAccount) fail('BadgeNotHeld', 'badge token account missing');
    else if (tokenAccountAddress && badgeTokenAccount.address !== tokenAccountAddress)
        fail('BadgeTokenAccountMismatch', 'not the token account recorded by SAS');
    else if (badgeTokenAccount.owner !== TOKEN_2022_PROGRAM_ADDRESS) fail('BadgeWrongTokenProgram', 'token account not Token-2022');
    else {
        try {
            const t = parseTokenAccount(badgeTokenAccount.data);
            if (badgeMint && t.mint !== badgeMint.address) fail('BadgeTokenAccountMismatch', 'token account mint mismatch');
            if (t.owner !== expectedWallet) fail('BadgeTokenAccountMismatch', 'token account owner mismatch');
            if (t.state !== 1) fail('MalformedBadgeTokenAccount', 'token account frozen or uninitialized');
            if (t.amount !== 1n) fail('BadgeNotHeld', `holds ${t.amount}`);
        } catch {
            fail('MalformedBadgeTokenAccount', 'badge token account is malformed');
        }
    }

    return { valid: reasons.length === 0, reasons, data, expiry };
}

function rawToEncoded(a: RawAccount) {
    return {
        address: a.address,
        data: a.data,
        executable: false,
        lamports: 0n as never,
        programAddress: a.owner,
        space: BigInt(a.data.length),
        exists: true as const,
    };
}

export type EligibilitySnapshot = {
    slot: bigint;
    now: bigint;
    wallet: Address;
    config: GateConfig | null;
    binding: (WalletBindingAccount & { address: Address }) | null;
    participant: (ParticipantAccount & { address: Address }) | null;
    badge: BadgeAccounts | null;
};

export type EligibilityReport = {
    wallet: Address;
    attestationValid: boolean;
    registryActive: boolean;
    eligible: boolean;
    reasons: Reason[];
    slot: string;
    participant: null | {
        address: Address;
        participantIdHex: string;
        currentWallet: Address;
        bindingVersion: number;
        status: (typeof ParticipantStatusName)[number];
        nextIntentNonce: string;
    };
    badge: null | { attestation: Address; badgeMint: Address; expiry: string | null };
};

/** Mirrors `gate::require_eligible` over a consistent snapshot. */
export function evaluateEligibility(s: EligibilitySnapshot, mode: GateMode = 'admission'): EligibilityReport {
    const reasons: Reason[] = [];
    let registryActive = false;
    let attestationValid = false;
    if (!s.config) reasons.push({ code: 'InvalidConfig', message: 'registry config not found' });
    else if (!s.binding) reasons.push({ code: 'NotRegistered', message: 'wallet has no registry binding' });
    else if (!s.participant) reasons.push({ code: 'NotRegistered', message: 'participant record missing' });
    else {
        const p = s.participant;
        const b = s.binding;
        const registryReasons: Reason[] = [];
        if (p.status === ParticipantStatus.Revoked) registryReasons.push({ code: 'ParticipantRevoked', message: 'revoked' });
        else if (p.status !== ParticipantStatus.Active) registryReasons.push({ code: 'ParticipantNotActive', message: 'suspended' });
        if (b.wallet !== p.currentWallet || p.currentWallet !== s.wallet)
            registryReasons.push({ code: 'WalletNotCurrent', message: 'wallet is not the current binding' });
        if (b.participant !== p.address) registryReasons.push({ code: 'WalletBindingMismatch', message: 'binding mismatch' });
        if (!b.active) registryReasons.push({ code: 'WalletBindingInactive', message: 'binding retired' });
        registryActive = registryReasons.length === 0;
        reasons.push(...registryReasons);

        if (s.badge) {
            const badgeReasons: Reason[] = [];
            if (s.badge.attestation?.address !== p.currentAttestation)
                badgeReasons.push({ code: 'AttestationNotCurrent', message: 'attestation is not current' });
            const check = checkBadge(s.config, s.badge, p.currentWallet, s.now, mode);
            badgeReasons.push(...check.reasons);
            if (check.data) {
                if (toHex(check.data.participantId) !== toHex(p.participantId))
                    badgeReasons.push({ code: 'ParticipantMismatch', message: 'participant id mismatch' });
                if (check.data.bindingVersion !== p.bindingVersion)
                    badgeReasons.push({ code: 'BindingVersionMismatch', message: 'binding version mismatch' });
            }
            attestationValid = badgeReasons.length === 0;
            reasons.push(...badgeReasons);
        }
    }
    const p = s.participant;
    return {
        wallet: s.wallet,
        attestationValid,
        registryActive,
        eligible: attestationValid && registryActive && reasons.length === 0,
        reasons,
        slot: s.slot.toString(),
        participant: p
            ? {
                  address: p.address,
                  participantIdHex: toHex(p.participantId),
                  currentWallet: p.currentWallet,
                  bindingVersion: p.bindingVersion,
                  status: ParticipantStatusName[p.status] ?? 'Revoked',
                  nextIntentNonce: p.nextIntentNonce.toString(),
              }
            : null,
        badge: p
            ? {
                  attestation: p.currentAttestation,
                  badgeMint: p.currentBadgeMint,
                  expiry: s.badge?.attestation ? (checkExpiry(s) ?? null) : null,
              }
            : null,
    };
}

function checkExpiry(s: EligibilitySnapshot): string | null {
    try {
        return decodeAttestation(rawToEncoded(s.badge!.attestation!)).data.expiry.toString();
    } catch {
        return null;
    }
}

export class RpcUnavailableError extends Error {
    constructor(cause: unknown) {
        super(`RPC unavailable: ${(cause as Error)?.message ?? cause}`);
        this.cause = cause;
    }
}

type GmaValue = { owner: Address; data: Base64EncodedDataResponse } | null;

/** Fetches accounts at `confirmed`, enforcing a monotonic context slot. */
async function fetchAccounts(
    rpc: Rpc<SolanaRpcApi>,
    addresses: Address[],
    minContextSlot?: bigint,
): Promise<{ slot: bigint; accounts: (RawAccount | null)[] }> {
    try {
        const res = await rpc
            .getMultipleAccounts(addresses, { commitment: 'confirmed', encoding: 'base64', minContextSlot })
            .send();
        const b64 = getBase64Encoder();
        return {
            slot: res.context.slot,
            accounts: (res.value as GmaValue[]).map((v, i) =>
                v ? { address: addresses[i], owner: v.owner, data: new Uint8Array(b64.encode(v.data[0])) } : null,
            ),
        };
    } catch (e) {
        throw new RpcUnavailableError(e);
    }
}

/** Reads a consistent eligibility snapshot for `wallet`. Throws RpcUnavailableError on RPC failure. */
export async function fetchEligibilitySnapshot(rpc: Rpc<SolanaRpcApi>, wallet: Address): Promise<EligibilitySnapshot> {
    const configAddress = await findConfigPda();
    const bindingAddress = await findWalletBindingPda(wallet);
    const r1 = await fetchAccounts(rpc, [configAddress, bindingAddress, SYSVAR_CLOCK_ADDRESS]);
    const [configAcct, bindingAcct, clockAcct] = r1.accounts;
    const ownedByGate = (a: RawAccount | null) => (a && a.owner === LEARNED_MARKETS_PROGRAM_ADDRESS ? a : null);
    const config = ownedByGate(configAcct) ? decodeConfig(configAcct!.data) : null;
    const binding = ownedByGate(bindingAcct) ? { ...decodeWalletBinding(bindingAcct!.data), address: bindingAddress } : null;
    let now = clockAcct ? getSysvarClockDecoder().decode(clockAcct.data).unixTimestamp : 0n;
    const snapshot: EligibilitySnapshot = { slot: r1.slot, now, wallet, config, binding, participant: null, badge: null };
    if (!config || !binding) return snapshot;

    const r2 = await fetchAccounts(rpc, [binding.participant], r1.slot);
    const pAcct = ownedByGate(r2.accounts[0]);
    if (!pAcct) return { ...snapshot, slot: r2.slot };
    const participant = { ...decodeParticipant(pAcct.data), address: binding.participant };
    if (participant.address !== (await findParticipantPda(participant.participantId))) return { ...snapshot, slot: r2.slot };

    const [ata] = await findAssociatedTokenPda({
        mint: participant.currentBadgeMint,
        owner: participant.currentWallet,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const r3 = await fetchAccounts(
        rpc,
        [config.credential, config.schema, participant.currentAttestation, participant.currentBadgeMint, ata, SYSVAR_CLOCK_ADDRESS],
        r2.slot,
    );
    const [credential, schema, attestation, badgeMint, badgeTokenAccount, clock2] = r3.accounts;
    if (clock2) now = getSysvarClockDecoder().decode(clock2.data).unixTimestamp;
    return {
        slot: r3.slot,
        now,
        wallet,
        config,
        binding,
        participant,
        badge: { credential, schema, schemaMint: config.schemaMint, attestation, badgeMint, badgeTokenAccount },
    };
}

export async function checkEligibility(rpc: Rpc<SolanaRpcApi>, wallet: Address, mode: GateMode = 'admission') {
    return evaluateEligibility(await fetchEligibilitySnapshot(rpc, wallet), mode);
}

/** Attestation-address inspection: validates a badge without consulting the registry. */
export async function inspectAttestation(rpc: Rpc<SolanaRpcApi>, attestationAddress: Address) {
    const configAddress = await findConfigPda();
    const r1 = await fetchAccounts(rpc, [configAddress, attestationAddress, SYSVAR_CLOCK_ADDRESS]);
    const [configAcct, attestation, clock] = r1.accounts;
    if (!configAcct) throw new Error('registry config not found');
    const config = decodeConfig(configAcct.data);
    const now = clock ? getSysvarClockDecoder().decode(clock.data).unixTimestamp : 0n;
    let wallet: Address | null = null;
    let tokenAccount: Address | null = null;
    if (attestation && attestation.owner === config.sasProgram && attestation.data[0] === SAS_DISCRIMINATOR.attestation) {
        const a = decodeAttestation(rawToEncoded(attestation)).data;
        tokenAccount = a.tokenAccount;
        try {
            wallet = decodeParticipantData(new Uint8Array(a.data)).wallet;
        } catch {
            /* reported by checkBadge */
        }
    }
    const { findAttestationMintPda } = await import('@solana/attestation');
    const [mint] = await findAttestationMintPda({ attestation: attestationAddress });
    const r2 = await fetchAccounts(rpc, [config.credential, config.schema, mint, ...(tokenAccount ? [tokenAccount] : [])], r1.slot);
    const [credential, schema, badgeMint, badgeTokenAccount] = r2.accounts;
    const check = checkBadge(
        config,
        { credential, schema, schemaMint: config.schemaMint, attestation, badgeMint, badgeTokenAccount: badgeTokenAccount ?? null },
        wallet ?? ('11111111111111111111111111111111' as Address),
        now,
        'standing',
    );
    return {
        attestation: attestationAddress,
        attestationValid: check.valid,
        reasons: check.reasons,
        slot: r2.slot.toString(),
        data: check.data
            ? {
                  appScope: check.data.appScope,
                  participantIdHex: toHex(check.data.participantId),
                  wallet: check.data.wallet,
                  verificationMethod: check.data.verificationMethod,
                  bindingVersion: check.data.bindingVersion,
                  issuedAt: check.data.issuedAt.toString(),
              }
            : null,
        expiry: check.expiry?.toString() ?? null,
        badgeMint: mint,
    };
}
