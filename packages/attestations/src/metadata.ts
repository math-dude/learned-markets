import { getMintSize, getTokenSize } from '@solana-program/token-2022';
import type { Address } from '@solana/kit';
import { BADGE_NAME, BADGE_SYMBOL } from './constants.ts';

/**
 * Exact Token-2022 size of a SAS badge mint, from the extensions SAS
 * initializes (see SAS `create_tokenized_attestation.rs`) and the real encoded
 * metadata, including the `attestation`/`schema` additional fields.
 */
export function badgeMintSpace(p: {
    attestation: Address;
    schema: Address;
    schemaMint: Address;
    sasAuthority: Address;
    badgeMint: Address;
    uri: string;
    name?: string;
    symbol?: string;
}): number {
    const size = getMintSize([
        { __kind: 'GroupMemberPointer', authority: p.sasAuthority, memberAddress: p.badgeMint },
        { __kind: 'NonTransferable' },
        { __kind: 'MetadataPointer', authority: p.sasAuthority, metadataAddress: p.badgeMint },
        { __kind: 'PermanentDelegate', delegate: p.sasAuthority },
        { __kind: 'MintCloseAuthority', closeAuthority: p.sasAuthority },
        {
            __kind: 'TokenMetadata',
            updateAuthority: p.sasAuthority,
            mint: p.badgeMint,
            name: p.name ?? BADGE_NAME,
            symbol: p.symbol ?? BADGE_SYMBOL,
            uri: p.uri,
            additionalMetadata: new Map([
                ['attestation', p.attestation],
                ['schema', p.schema],
            ]),
        },
        { __kind: 'TokenGroupMember', group: p.schemaMint, mint: p.badgeMint, memberNumber: 1n },
    ]);
    if (size > 0xffff) throw new Error('badge mint space exceeds u16');
    return size;
}

/** Holder token account for a non-transferable badge (ATA extensions). */
export function badgeTokenAccountSpace(): number {
    return getTokenSize([{ __kind: 'ImmutableOwner' }, { __kind: 'NonTransferableAccount' }]);
}

/**
 * Default public badge metadata. Appearance customization is deferred; when
 * added it must live in separate fields and never alter identity, issuer,
 * schema or authorization data (those are on-chain and verified separately).
 */
export function badgeMetadataJson(origin: string) {
    return {
        name: BADGE_NAME,
        symbol: BADGE_SYMBOL,
        description:
            'Non-transferable Learned Markets devnet test pass. Display only: eligibility is verified against the ' +
            'underlying attestation and the on-chain registry, which may be expired, revoked or suspended.',
        image: `${origin}/v1/badge/image.svg`,
        external_url: origin,
        attributes: [
            { trait_type: 'Network', value: 'devnet' },
            { trait_type: 'Verification', value: 'Operator-approved test participant' },
        ],
        properties: { category: 'image', files: [{ uri: `${origin}/v1/badge/image.svg`, type: 'image/svg+xml' }] },
    };
}

export const BADGE_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Learned Markets Demo Pass">
<rect width="512" height="512" rx="64" fill="#0f172a"/>
<circle cx="256" cy="210" r="104" fill="none" stroke="#38bdf8" stroke-width="20"/>
<path d="M200 230l40 40 76-88" fill="none" stroke="#38bdf8" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
<text x="256" y="384" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#f8fafc">Learned Markets</text>
<text x="256" y="432" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#94a3b8">DEMO PASS · devnet</text>
</svg>
`;
