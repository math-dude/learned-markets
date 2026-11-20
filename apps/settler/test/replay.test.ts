import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { address, signature } from '@solana/kit';
import { encodeTrade, LEARNED_MARKETS_PROGRAM_ADDRESS as program, toHex } from '@learned-markets/attestations';
import { encodeReveal } from '@learned-markets/client/settlement-v2';
import { getIntentSubmittedEventEncoder } from '@learned-markets/client/generated';
import { replayClearing, type ClearRequest } from '../src/clearing.ts';
import { decodeLogs } from '../src/events.ts';
import { Store } from '../src/store.ts';

const market = address('11111111111111111111111111111111');
const sig = signature('1'.repeat(64));
test('ingestion attributes only program-owned data, persists idempotently and keeps order payloads private', () => {
    const encoder = getIntentSubmittedEventEncoder();
    const data = encoder.encode({ intent: market, participant: market, nonce: 0n, kind: 0, target: market, payloadHash: new Uint8Array(32), deadline: 80n });
    const line = 'Program data: ' + Buffer.from(data).toString('base64');
    const events = decodeLogs(['Program '+program+' invoke [1]', 'Program '+market+' invoke [2]', line,
        'Program '+market+' success',line,'Program '+program+' success']);
    assert.equal(events.length,1);
    const store = new Store(':memory:','local');
    store.order(market,market,20n,'private-curve');
    for (let i=0;i<2;i++) store.ingest(sig,20n,events);
    assert.equal(store.events(market).length,1);
    assert.ok(!JSON.stringify(store.events(market)).includes('private-curve'));
    assert.deepEqual(store.orders(market,19n,20n),[{ intent:market,contents_hex:'private-curve' }]);
    assert.deepEqual(store.orders(market,20n,21n),[]);
    store.db.close();
});

test('QuickNode Solana block filter emits signatures only for successful invocations', async () => {
    const script = await readFile(new URL('../../../scripts/quicknode-filter.js',import.meta.url),'utf8');
    const tx = { meta: { err:null, logMessages:['Program '+program+' invoke [1]'] }, transaction:{signatures:[sig]} };
    const stream = {data:[{transactions:[tx,{...tx,meta:{...tx.meta,err:'failed'}},{...tx,meta:{err:null,logMessages:[]}}]}]};
    const result = runInContext(script+'; main(stream)',createContext({stream}));
    assert.deepEqual(JSON.parse(JSON.stringify(result)),{signatures:[sig]});
});

test('price follows submitted volume before clipping an unfunded buyer', () => {
    const input: ClearRequest = {
        market: { stage: 'Rookie', total_supply:'100000000',last_price:'1000000',maker_base:'50000000',maker_quote:'0',
            risk_allowance:'0',bounds:{min_cap_bps:50,max_cap_bps:400,rookie_max_cap_bps:200,max_total_fee_bps:500,
                max_hold_secs:3600,max_per_person_batch_max:'9000000'},limits:{max_net_sell_per_batch:'9000000',
                max_net_buy_per_batch:'9000000',max_price_move_bps:100,rookie_max_price_move_bps:500} },
        terms:{version:1,base_fee_bps:10,speed_fee_bps:50,hold_fee_bps:50,hold_secs:300,large_holder_share_bps:100,
            large_holder_fee_bps:25,cap_bps:200,per_person_batch_max:'9000000'}, last_price:'1000000',now:'1000',
        maker_reveal:toHex(encodeReveal({sell:{side:'sell',points:[{price:950000n,quantity:10n},{price:1050000n,quantity:20n}]}})),
        user_curves:[{intent:'a',participant:'x',contents_hex:toHex(encodeTrade({side:'buy',points:[{price:1050000n,quantity:20n}]})),
            position:{base:'0',external_base:'0',last_buy_ts:'0',quote:'0'}}] };
    assert.deepEqual(replayClearing(input),{clearing_price:'1050000',fills:[{intent:'a',fill:'0'}]});
    const order=input.user_curves[0];
    order.position.quote='1000';
    input.user_curves.push({...order, intent:'b', participant:'y'}, {...order, intent:'c', participant:'z'});
    assert.deepEqual(replayClearing(input).fills,[{intent:'a',fill:'7'},{intent:'b',fill:'7'},{intent:'c',fill:'6'}]);
});
