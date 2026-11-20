import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { address, AccountRole, type Address } from '@solana/kit';
import {
    attestationNonce,
    badgeMintSpace,
    cancelIntentInstruction,
    checkBadge,
    decodeConfig,
    decodeIntent,
    decodeNomination,
    decodeParticipant,
    decodeParticipantData,
    decodeTrade,
    decodeWalletBinding,
    encodeNomination,
    encodeParticipantData,
    encodeTrade,
    evaluateEligibility,
    findConfigPda,
    findIntentPda,
    findParticipantPda,
    findWalletBindingPda,
    fromHex,
    initializeConfigInstruction,
    IntentKind,
    payloadHash,
    registerParticipantInstruction,
    replaceBindingInstruction,
    settleBatchInstruction,
    submitIntentInstruction,
    toHex,
    updateConfigInstruction,
    validateContents,
    type BadgeAccounts,
    type RawAccount,
} from '../src/index.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8'));
const attVectors = fixture('participant-attestation-vectors.json');
const payloadVectors = fixture('intent-payload-vectors.json');
const chain = fixture('onchain-accounts.json');

const raw = (key: string): RawAccount => {
    const a = chain.accounts[key];
    return { address: address(a.address), owner: address(a.owner), data: new Uint8Array(Buffer.from(a.dataBase64, 'base64')) };
};

test('participant attestation data matches Rust encoding', () => {
    for (const v of attVectors.valid) {
        const data = {
            appScope: v.appScope,
            participantId: fromHex(v.participantIdHex),
            wallet: address(v.wallet),
            verificationMethod: v.verificationMethod,
            bindingVersion: v.bindingVersion,
            issuedAt: BigInt(v.issuedAt),
        };
        assert.equal(toHex(encodeParticipantData(data)), v.hex);
        assert.deepEqual(decodeParticipantData(fromHex(v.hex)), data);
    }
    for (const m of attVectors.malformed) {
        assert.throws(() => decodeParticipantData(fromHex(m.hex)), m.label);
    }
    for (const n of attVectors.nonces) {
        assert.equal(attestationNonce(fromHex(n.participantIdHex), n.bindingVersion), n.nonce);
    }
    assert.deepEqual(attVectors.layout, [12, 13, 13, 0, 2, 8]);
});

test('intent payload hashes and contents match Rust', () => {
    for (const v of payloadVectors.valid) {
        const contents = fromHex(v.contentsHex);
        assert.equal(toHex(payloadHash(v.appScope, v.network, v.kind, address(v.target), contents)), v.payloadHashHex, v.label);
        validateContents(v.kind, contents);
        const reencoded = v.kind === IntentKind.Trade ? encodeTrade(decodeTrade(contents)) : encodeNomination(decodeNomination(contents));
        assert.equal(toHex(reencoded), v.contentsHex, v.label);
    }
    for (const v of payloadVectors.invalid) {
        assert.throws(() => validateContents(v.kind, fromHex(v.contentsHex)), v.label);
    }
});

test('real on-chain gate accounts decode in TypeScript', async () => {
    const cfg = decodeConfig(raw('config').data);
    assert.equal(cfg.appScope, chain.appScope);
    assert.equal(cfg.network, chain.network);
    assert.equal(cfg.admin, chain.keys.admin);
    assert.equal(cfg.settlementAuthority, chain.keys.settlementAuthority);
    assert.equal(cfg.credentialAuthority, chain.keys.credentialAuthority);
    assert.equal(cfg.credential, chain.accounts.credential.address);
    assert.equal(cfg.schema, chain.accounts.schema.address);
    assert.equal(cfg.schemaMint, chain.accounts.schemaMint.address);
    assert.equal(cfg.admissionPaused, false);

    const p = decodeParticipant(raw('participant').data);
    assert.equal(toHex(p.participantId), chain.participantIdHex);
    assert.equal(p.currentWallet, chain.keys.wallet);
    assert.equal(p.currentAttestation, chain.accounts.attestation.address);
    assert.equal(p.currentBadgeMint, chain.accounts.badgeMint.address);
    assert.equal(p.bindingVersion, 1);
    assert.equal(p.status, 0);
    assert.equal(p.nextIntentNonce, 1n);

    const b = decodeWalletBinding(raw('walletBinding').data);
    assert.equal(b.wallet, chain.keys.wallet);
    assert.equal(b.participant, chain.accounts.participant.address);
    assert.equal(b.active, true);

    const i = decodeIntent(raw('intent').data);
    assert.equal(i.participant, chain.accounts.participant.address);
    assert.equal(i.nonce, 0n);
    assert.equal(i.kind, IntentKind.Trade);
    assert.equal(i.target, chain.market);
    assert.equal(toHex(i.payloadHash), chain.payloadHashHex);
    assert.equal(i.deadline, BigInt(chain.deadline));
    assert.equal(i.state, 0);

    // PDAs
    const pid = fromHex(chain.participantIdHex);
    assert.equal(await findConfigPda(), chain.accounts.config.address);
    assert.equal(await findParticipantPda(pid), chain.accounts.participant.address);
    assert.equal(await findWalletBindingPda(address(chain.keys.wallet)), chain.accounts.walletBinding.address);
    assert.equal(await findIntentPda(address(chain.accounts.participant.address), 0n), chain.accounts.intent.address);
    // Wrong discriminator rejected
    assert.throws(() => decodeParticipant(raw('config').data));
});

test('payload hash of the fixture trade matches the on-chain intent', () => {
    const h = payloadHash(chain.appScope, chain.network, IntentKind.Trade, address(chain.market), fromHex(chain.tradeContentsHex));
    assert.equal(toHex(h), chain.payloadHashHex);
});

test('badge mint sizing matches the real SAS mint exactly', () => {
    const size = badgeMintSpace({
        attestation: address(chain.accounts.attestation.address),
        schema: address(chain.accounts.schema.address),
        schemaMint: address(chain.accounts.schemaMint.address),
        sasAuthority: decodeConfig(raw('config').data).sasAuthority,
        badgeMint: address(chain.accounts.badgeMint.address),
        uri: chain.badge.uri,
    });
    assert.equal(size, chain.badge.mintAccountSpace);
    assert.equal(size, chain.badge.mintActualDataLen);
});

function badgeAccounts(): BadgeAccounts {
    const cfg = decodeConfig(raw('config').data);
    return {
        credential: raw('credential'),
        schema: raw('schema'),
        schemaMint: cfg.schemaMint,
        attestation: raw('attestation'),
        badgeMint: raw('badgeMint'),
        badgeTokenAccount: raw('badgeTokenAccount'),
    };
}

test('verifier accepts the real badge and mirrors on-chain rejections', () => {
    const cfg = decodeConfig(raw('config').data);
    const wallet = address(chain.keys.wallet);
    const now = BigInt(chain.now);
    const ok = checkBadge(cfg, badgeAccounts(), wallet, now, 'admission');
    assert.deepEqual(ok.reasons, []);
    assert.equal(ok.valid, true);

    const codes = (r: ReturnType<typeof checkBadge>) => r.reasons.map(x => x.code);
    assert.ok(codes(checkBadge(cfg, badgeAccounts(), address(chain.keys.admin), now, 'admission')).includes('WalletMismatch'));
    assert.ok(codes(checkBadge(cfg, badgeAccounts(), wallet, BigInt(chain.badge.expiry), 'admission')).includes('AttestationExpired'));
    assert.ok(codes(checkBadge({ ...cfg, admissionPaused: true }, badgeAccounts(), wallet, now, 'admission')).includes('AdmissionSuspended'));
    assert.equal(checkBadge({ ...cfg, admissionPaused: true }, badgeAccounts(), wallet, now, 'standing').valid, true);
    assert.ok(codes(checkBadge({ ...cfg, credentialAuthority: cfg.admin }, badgeAccounts(), wallet, now, 'admission')).includes('UntrustedCredentialAuthority'));
    assert.ok(codes(checkBadge({ ...cfg, network: 'other', schema: cfg.admin }, badgeAccounts(), wallet, now, 'admission')).includes('UntrustedSchema'));

    // Closed attestation, burned badge, counterfeit owner
    assert.ok(codes(checkBadge(cfg, { ...badgeAccounts(), attestation: null }, wallet, now, 'admission')).includes('SasWrongOwner'));
    const burned = raw('badgeTokenAccount');
    burned.data = new Uint8Array(burned.data);
    burned.data.fill(0, 64, 72);
    assert.ok(codes(checkBadge(cfg, { ...badgeAccounts(), badgeTokenAccount: burned }, wallet, now, 'admission')).includes('BadgeNotHeld'));
    const fakeMint = { ...raw('badgeMint'), owner: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
    assert.ok(codes(checkBadge(cfg, { ...badgeAccounts(), badgeMint: fakeMint }, wallet, now, 'admission')).includes('BadgeWrongTokenProgram'));
    const forged = { ...raw('attestation'), owner: chain.programId as Address };
    assert.ok(codes(checkBadge(cfg, { ...badgeAccounts(), attestation: forged }, wallet, now, 'admission')).includes('SasWrongOwner'));
});

test('eligibility report combines registry and badge status', () => {
    const cfg = decodeConfig(raw('config').data);
    const participant = { ...decodeParticipant(raw('participant').data), address: address(chain.accounts.participant.address) };
    const binding = { ...decodeWalletBinding(raw('walletBinding').data), address: address(chain.accounts.walletBinding.address) };
    const base = { slot: 7n, now: BigInt(chain.now), wallet: address(chain.keys.wallet), config: cfg, binding, participant, badge: badgeAccounts() };
    const r = evaluateEligibility(base);
    assert.equal(r.eligible, true, JSON.stringify(r.reasons));
    assert.equal(r.attestationValid, true);
    assert.equal(r.registryActive, true);
    assert.equal(r.slot, '7');

    const suspended = evaluateEligibility({ ...base, participant: { ...participant, status: 1 } });
    assert.equal(suspended.registryActive, false);
    assert.equal(suspended.attestationValid, true);
    assert.equal(suspended.eligible, false);
    assert.deepEqual(suspended.reasons.map(x => x.code), ['ParticipantNotActive']);

    const expired = evaluateEligibility({ ...base, now: BigInt(chain.badge.expiry) + 1n });
    assert.equal(expired.registryActive, true);
    assert.equal(expired.attestationValid, false);
    assert.equal(expired.eligible, false);

    const unregistered = evaluateEligibility({ ...base, binding: null, participant: null, badge: null });
    assert.deepEqual(unregistered.reasons.map(x => x.code), ['NotRegistered']);
});

type FixtureIx = { dataHex: string; accounts: [string, boolean, boolean][] };
function assertIx(built: { data: Uint8Array; accounts: readonly { address: Address; role: AccountRole }[] }, expected: FixtureIx, label: string) {
    assert.equal(toHex(built.data), expected.dataHex, `${label} data`);
    const metas = built.accounts.map(a => [
        a.address,
        a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
        a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
    ]);
    assert.deepEqual(metas, expected.accounts, `${label} accounts`);
}

test('gate instruction builders match the harness byte-for-byte', async () => {
    const k = chain.keys;
    const a = (s: string) => address(s);
    const pid = fromHex(chain.participantIdHex);
    const cfg = decodeConfig(raw('config').data);
    const badge = {
        credential: cfg.credential,
        schema: cfg.schema,
        schemaMint: cfg.schemaMint,
        attestation: a(chain.accounts.attestation.address),
        badgeMint: a(chain.accounts.badgeMint.address),
        badgeTokenAccount: a(chain.accounts.badgeTokenAccount.address),
    };
    const I = chain.instructions;
    assertIx(
        await initializeConfigInstruction({
            payer: a(k.payer), deploymentAuthority: a(k.deployer), credential: cfg.credential, schema: cfg.schema,
            network: chain.network, admin: a(k.admin), settlementAuthority: a(k.settlementAuthority), credentialAuthority: a(k.credentialAuthority),
        }),
        I.initializeConfig, 'initialize_config',
    );
    assertIx(await updateConfigInstruction({ admin: a(k.admin), admissionPaused: true }), I.updateConfig, 'update_config');
    assertIx(await registerParticipantInstruction({ payer: a(k.payer), wallet: a(k.wallet), participantId: pid, badge }), I.registerParticipant, 'register');
    assertIx(
        await replaceBindingInstruction({ payer: a(k.payer), admin: a(k.admin), newWallet: a(k.wallet), participantId: pid, badge }),
        I.replaceBindingRenewal, 'replace_binding',
    );
    const submit = await submitIntentInstruction({
        wallet: a(k.wallet), participantId: pid, badge, nonce: 0n, kind: IntentKind.Trade, target: a(chain.market),
        payloadHash: fromHex(chain.payloadHashHex), deadline: BigInt(chain.deadline),
    });
    assertIx(submit, I.submitIntent, 'submit_intent');
    assert.equal(submit.intent, chain.accounts.intent.address);
    assertIx(await cancelIntentInstruction({ wallet: a(k.wallet), participantId: pid, nonce: 0n }), I.cancelIntent, 'cancel_intent');
    assertIx(
        await settleBatchInstruction({
            settlementAuthority: a(k.settlementAuthority), credential: cfg.credential, schema: cfg.schema, schemaMint: cfg.schemaMint,
            market: a(chain.market), batchId: 42n,
            items: [{
                intent: a(chain.accounts.intent.address), contents: fromHex(chain.tradeContentsHex),
                participant: a(chain.accounts.participant.address), walletBinding: a(chain.accounts.walletBinding.address),
                attestation: badge.attestation, badgeMint: badge.badgeMint, badgeTokenAccount: badge.badgeTokenAccount,
            }],
        }),
        I.settleBatch, 'settle_batch',
    );
});
