export type ServiceConfig = {
    /** Exact origin the service is served from; bound into every signed challenge. */
    origin: string;
    /** HTTPS origin serving badge metadata and artwork (used as the badge URI at issuance). */
    badgeOrigin: string;
    port: number;
    dbPath: string;
    rpcUrl: string;
    network: string;
    /** Operator fee payer, used as fee payer for co-signed replacement transactions. */
    operatorPayer: string | null;
    secureCookies: boolean;
};

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 15 * 60 * 1000;
export const SESSION_COOKIE = 'lm_session';

function requireHttps(name: string, value: string): string {
    const u = new URL(value);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !local) throw new Error(`${name} must be an https origin`);
    return u.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
    const origin = requireHttps('SERVICE_ORIGIN', env.SERVICE_ORIGIN ?? 'http://localhost:8787');
    return {
        origin,
        badgeOrigin: requireHttps('BADGE_METADATA_ORIGIN', env.BADGE_METADATA_ORIGIN ?? origin),
        port: Number(env.PORT ?? 8787),
        dbPath: env.DB_PATH ?? 'attestation-service.sqlite',
        rpcUrl: env.LM_RPC_URL ?? 'https://api.devnet.solana.com',
        network: env.LM_NETWORK ?? 'devnet',
        operatorPayer: env.OPERATOR_PAYER ?? null,
        secureCookies: new URL(origin).protocol === 'https:',
    };
}
