#!/usr/bin/env node
/**
 * lm-attest — operator commands for the Learned Markets Demo Issuer and gate.
 *
 *   LM_RPC_URL   RPC endpoint (default https://api.devnet.solana.com)
 *   LM_KEYS_DIR  directory with operator keypairs (default ./keys, git-ignored)
 *
 * Keys (solana-keygen JSON): payer, credential-authority, issuance-signer,
 * admin, deployer, settlement-authority. Signing keys never leave operator tooling.
 */
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { address, type Address } from '@solana/kit';
import {
    badgeAddresses,
    badgeMintSpace,
    badgeTokenAccountSpace,
    checkEligibility,
    findConfigPda,
    fromHex,
    generateKeypairFile,
    initializeGate,
    inspectAttestation,
    issueBadge,
    issuerAddresses,
    loadSigner,
    revokeBadge,
    revokeParticipant,
    rpcFor,
    setAdmissionPaused,
    setSchemaPaused,
    setupIssuer,
    suspendParticipant,
    toHex,
} from './index.ts';

const KEY_NAMES = ['payer', 'credential-authority', 'issuance-signer', 'admin', 'deployer', 'settlement-authority'] as const;
type KeyName = (typeof KEY_NAMES)[number];

const rpcUrl = process.env.LM_RPC_URL ?? 'https://api.devnet.solana.com';
const keysDir = process.env.LM_KEYS_DIR ?? 'keys';
const key = (name: KeyName) => loadSigner(join(keysDir, `${name}.json`));

const json = (v: unknown) =>
    console.log(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? toHex(x) : x), 2));

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        'participant-id': { type: 'string' },
        wallet: { type: 'string' },
        version: { type: 'string' },
        uri: { type: 'string' },
        lifetime: { type: 'string' },
        attestation: { type: 'string' },
        'token-account': { type: 'string' },
        network: { type: 'string' },
    },
});

function need<T extends string>(v: T | undefined, name: string): T {
    if (!v) throw new Error(`--${name} is required`);
    return v;
}

function participantId(): Uint8Array {
    const v = need(values['participant-id'], 'participant-id');
    const id = fromHex(v);
    if (id.length !== 32) throw new Error('participant id must be 32 bytes of hex');
    return id;
}

async function main() {
    const rpc = rpcFor(rpcUrl);
    const cmd = positionals[0];
    switch (cmd) {
        case 'keys:init': {
            const out: Record<string, string> = {};
            for (const name of KEY_NAMES) {
                const path = join(keysDir, `${name}.json`);
                try {
                    await access(path);
                    out[name] = (await loadSigner(path)).address;
                } catch {
                    out[name] = await generateKeypairFile(path);
                }
            }
            return json(out);
        }
        case 'participant-id:new':
            return json({ participantIdHex: toHex(new Uint8Array(randomBytes(32))) });
        case 'addresses': {
            const ca = await key('credential-authority');
            return json({ rpcUrl, config: await findConfigPda(), ...(await issuerAddresses(ca.address)) });
        }
        case 'issuer:setup': {
            const [payer, credentialAuthority, issuance] = await Promise.all([key('payer'), key('credential-authority'), key('issuance-signer')]);
            return json(await setupIssuer(rpc, { payer, credentialAuthority, issuanceSigner: issuance.address }));
        }
        case 'gate:init': {
            const [payer, deployer, ca, admin, sa] = await Promise.all([
                key('payer'), key('deployer'), key('credential-authority'), key('admin'), key('settlement-authority'),
            ]);
            const issuer = await issuerAddresses(ca.address);
            return json(
                await initializeGate(rpc, {
                    payer, deployer, issuer, credentialAuthority: ca.address, admin: admin.address,
                    settlementAuthority: sa.address, network: values.network ?? 'devnet',
                }),
            );
        }
        case 'badge:issue': {
            const [payer, issuanceSigner, ca] = await Promise.all([key('payer'), key('issuance-signer'), key('credential-authority')]);
            const issuer = await issuerAddresses(ca.address);
            return json(
                await issueBadge(rpc, { payer, issuanceSigner }, issuer, {
                    participantId: participantId(),
                    wallet: address(need(values.wallet, 'wallet')),
                    bindingVersion: Number(need(values.version, 'version')),
                    uri: need(values.uri, 'uri'),
                    lifetimeSecs: values.lifetime ? Number(values.lifetime) : undefined,
                }),
            );
        }
        case 'badge:revoke': {
            const [payer, issuanceSigner, ca] = await Promise.all([key('payer'), key('issuance-signer'), key('credential-authority')]);
            const issuer = await issuerAddresses(ca.address);
            return json(
                await revokeBadge(rpc, { payer, issuanceSigner }, issuer, {
                    attestation: address(need(values.attestation, 'attestation')),
                    badgeTokenAccount: address(need(values['token-account'], 'token-account')),
                }),
            );
        }
        case 'schema:pause':
        case 'schema:resume': {
            const [payer, credentialAuthority] = await Promise.all([key('payer'), key('credential-authority')]);
            return json(await setSchemaPaused(rpc, { payer, credentialAuthority }, await issuerAddresses(credentialAuthority.address), cmd === 'schema:pause'));
        }
        case 'admission:pause':
        case 'admission:resume': {
            const [payer, admin] = await Promise.all([key('payer'), key('admin')]);
            return json(await setAdmissionPaused(rpc, { payer, admin }, cmd === 'admission:pause'));
        }
        case 'participant:suspend':
        case 'participant:revoke': {
            const [payer, admin] = await Promise.all([key('payer'), key('admin')]);
            const fn = cmd === 'participant:suspend' ? suspendParticipant : revokeParticipant;
            return json(await fn(rpc, { payer, admin }, participantId()));
        }
        case 'inspect':
            return json(await inspectAttestation(rpc, address(need(values.attestation, 'attestation'))));
        case 'eligibility':
            return json(await checkEligibility(rpc, address(need(values.wallet, 'wallet'))));
        case 'estimate': {
            const ca = await key('credential-authority');
            const issuer = await issuerAddresses(ca.address);
            const wallet = (values.wallet ?? ca.address) as Address;
            const addrs = await badgeAddresses(issuer, new Uint8Array(32), 1, wallet);
            const mintSpace = badgeMintSpace({ ...issuer, attestation: addrs.attestation, badgeMint: addrs.badgeMint, uri: need(values.uri, 'uri') });
            const tokenSpace = badgeTokenAccountSpace();
            const attestationSpace = 1 + 32 * 3 + 4 + (4 + 20 + 36 + 36 + 1 + 4 + 8) + 32 + 8 + 32;
            const rent = async (n: number) => rpc.getMinimumBalanceForRentExemption(BigInt(n)).send();
            return json({
                mintAccountSpace: mintSpace, mintRentLamports: await rent(mintSpace),
                tokenAccountSpace: tokenSpace, tokenAccountRentLamports: await rent(tokenSpace),
                attestationSpace, attestationRentLamports: await rent(attestationSpace),
            });
        }
        default:
            console.error(
                'usage: lm-attest <keys:init|participant-id:new|addresses|issuer:setup|gate:init|badge:issue|badge:revoke|' +
                    'schema:pause|schema:resume|admission:pause|admission:resume|participant:suspend|participant:revoke|' +
                    'inspect|eligibility|estimate> [options]',
            );
            process.exitCode = 2;
    }
}

main().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
});
