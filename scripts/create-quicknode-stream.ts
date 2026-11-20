import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const key = process.env.QUICKNODE_API_KEY, token = process.env.STREAM_WEBHOOK_TOKEN;
const destination = new URL(process.env.STREAM_WEBHOOK_URL ?? '');
if (!key || !token || destination.protocol !== 'https:' || destination.pathname !== '/stream') {
    throw new Error('QUICKNODE_API_KEY, STREAM_WEBHOOK_TOKEN and HTTPS STREAM_WEBHOOK_URL ending in /stream are required');
}
const source = await readFile(new URL('./quicknode-filter.js', import.meta.url));
const id = createHash('sha256').update('learned-markets-solana-devnet:' + destination.href).digest('hex');
const response = await fetch('https://api.quicknode.com/streams/rest/v1/streams', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ external_id: id, name: 'Learned Markets settlement v2', network: 'solana-devnet', dataset: 'block',
        region: 'usa_east', filter_function: source.toString('base64'), dataset_batch_size: 1, destination: 'webhook',
        destination_attributes: { url: destination.href, headers: { Authorization: 'Bearer ' + token }, compression: 'none',
            max_retry: 5, retry_interval_sec: 5, post_timeout_sec: 30 }, status: 'active' }),
});
if (!response.ok) throw new Error('QuickNode stream creation failed with HTTP ' + response.status);
const result = await response.json();
console.log(JSON.stringify({ id: result.id, status: result.status, network: result.network, dataset: result.dataset }));
