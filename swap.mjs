// swap.mjs: real gasless refuel. Fresh quote-2.0 (gasless) -> sign best prebuilt tx -> submit-tx -> free RPC status.
// Secret key is never printed.
import { createX402Client } from 'x402-solana/client';
import { Keypair, VersionedTransaction, Connection } from '@solana/web3.js';
import { readFileSync, writeFileSync } from 'node:fs';

const AMOUNT = process.env.AMOUNT || '3000000';
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.PAYER_KEYPAIR, 'utf8'))));
const me = payer.publicKey.toString();
const RPC = 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const client = createX402Client({
  wallet: { address: me, signTransaction: async (tx) => { tx.sign([payer]); return tx; } },
  network: 'solana', rpcUrl: RPC,
});
const receiptOf = (r) => { const h = r.headers.get('x-payment-response'); return h ? JSON.parse(Buffer.from(h, 'base64').toString()) : null; };
const log = {};

const q = await client.fetch('https://hermes.swap.io/v1/swap/quote-2.0', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input: { token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: AMOUNT, chainKey: 'sol' },
    output: { token: 'So11111111111111111111111111111111111111112', chainKey: 'sol' },
    userAddress: me, slippageBps: 100, gasless: true,
  }),
});
const qj = await q.json();
log.quote = { status: q.status, receipt: receiptOf(q) };
const best = (qj.quotes || []).find((x) => x.bestQuote) || (qj.quotes || [])[0];
if (!best?.simulation?.success || !best.simulation.transaction) { console.log('NO_SIM', JSON.stringify(qj).slice(0, 600)); process.exit(1); }
log.best = { provider: best.provider.key, out: best.simulation.primaryOutput, gasless: best.simulation.gasless };
console.log('quote', q.status, 'receipt', log.quote.receipt?.transaction, 'best', best.provider.key, best.simulation.primaryOutput.amountFormatted, 'SOL');

const tx = VersionedTransaction.deserialize(Buffer.from(best.simulation.transaction, 'base64'));
tx.sign([payer]);
const signed = Buffer.from(tx.serialize()).toString('base64');

const s = await client.fetch('https://hermes.swap.io/v1/swap/submit-tx', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ signedTransaction: signed, provider: best.provider.key, chainKey: 'sol' }),
});
const sj = await s.json();
log.submit = { status: s.status, receipt: receiptOf(s), body: sj };
console.log('submit', s.status, JSON.stringify(sj).slice(0, 400), 'receipt', log.submit.receipt?.transaction);

if (sj.transactionHash) {
  for (let i = 0; i < 20; i++) {
    const st = (await conn.getSignatureStatuses([sj.transactionHash])).value[0];
    if (st && (st.err || st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { log.chain = st; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('chain', JSON.stringify(log.chain));
}
log.solAfter = await conn.getBalance(payer.publicKey);
console.log('SOL lamports after', log.solAfter);
writeFileSync(new URL('./out/swap_run.json', import.meta.url), JSON.stringify(log, null, 2));
