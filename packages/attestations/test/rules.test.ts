import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import {
    APP_SCOPE,
    encodeParticipantData,
    encodeTrade,
    encodeNomination,
    validityWindowError,
    attestationNonce,
    ParticipantDataError,
    PayloadError,
} from '../src/index.ts';

const WALLET = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const base = { appScope: APP_SCOPE, participantId: new Uint8Array(32).fill(1), wallet: WALLET, verificationMethod: 0, bindingVersion: 1, issuedAt: 0n };

test('validity window boundaries match the program', () => {
    const now = 1_000_000n;
    const week = 7n * 86_400n;
    assert.equal(validityWindowError(now, now + week, now), null);
    assert.equal(validityWindowError(now, now + week + 1n, now), 'AttestationLifetimeTooLong');
    assert.equal(validityWindowError(now, 0n, now), 'NonExpiringAttestation');
    assert.equal(validityWindowError(now - 10n, now, now), 'AttestationExpired');
    assert.equal(validityWindowError(now - 10n, now + 1n, now), null);
    assert.equal(validityWindowError(now + 30n, now + 100n, now), null);
    assert.equal(validityWindowError(now + 31n, now + 100n, now), 'AttestationIssuedInFuture');
});

test('encoder refuses semantically invalid participant data', () => {
    assert.throws(() => encodeParticipantData({ ...base, appScope: 'other' }), ParticipantDataError);
    assert.throws(() => encodeParticipantData({ ...base, verificationMethod: 1 }), ParticipantDataError);
    assert.throws(() => encodeParticipantData({ ...base, participantId: new Uint8Array(31) }), ParticipantDataError);
    assert.throws(() => encodeParticipantData({ ...base, bindingVersion: 0 }), ParticipantDataError);
    assert.equal(encodeParticipantData(base).length, 4 + APP_SCOPE.length + 36 + 36 + 1 + 4 + 8);
});

test('nonce changes with participant and version', () => {
    const a = attestationNonce(base.participantId, 1);
    assert.notEqual(a, attestationNonce(base.participantId, 2));
    assert.notEqual(a, attestationNonce(new Uint8Array(32).fill(2), 1));
    assert.throws(() => attestationNonce(new Uint8Array(31), 1));
});

test('trade and nomination encoders enforce canonical form', () => {
    assert.throws(() => encodeTrade({ side: 'buy', points: [] }), PayloadError);
    assert.throws(() => encodeTrade({ side: 'buy', points: [{ price: 1n, quantity: 1n << 64n }] }), PayloadError);
    assert.throws(() => encodeTrade({ side: 'sell', points: [{ price: 1n, quantity: 5n }, { price: 2n, quantity: 4n }] }), PayloadError);
    assert.equal(encodeTrade({ side: 'buy', points: [{ price: 1n, quantity: 5n }, { price: 2n, quantity: 4n }] }).length, 3 + 32);
    assert.throws(() => encodeNomination({ candidate: address('11111111111111111111111111111111') }), PayloadError);
});
