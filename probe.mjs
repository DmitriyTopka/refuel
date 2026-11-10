// probe.mjs: one paid quote-2.0 call with gasless:true for a 3 USDC -> SOL swap.
// Shows whether every provider's built transaction simulates OK for a wallet with 0 SOL.
// Does NOT sign or send any swap. Secret key is never printed.
import { createX402Client } from 'x402-solana/client';
import { Keypair } from '@solana/web3.js';
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.PAYER_KEYPAIR;
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(KEY, 'utf8'))));
const me = payer.publicKey.toString();
const client = createX402Client({
  wallet: { address: me, signTransaction: async (tx) => { tx.sign([payer]); return tx; } },
  network: 'solana',
  rpcUrl: 'https://api.mainnet-beta.solana.com',
});

const body = {
  input: { token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '3000000', chainKey: 'sol' },
  output: { token: 'So11111111111111111111111111111111111111112', chainKey: 'sol' },
  userAddress: me,
  slippageBps: 100,
  gasless: true,
};
const resp = await client.fetch('https://hermes.swap.io/v1/swap/quote-2.0', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const receiptB64 = resp.headers.get('x-payment-response');
const receipt = receiptB64 ? JSON.parse(Buffer.from(receiptB64, 'base64').toString()) : null;
const json = await resp.json();
writeFileSync(new URL('./out/probe_quote2.json', import.meta.url), JSON.stringify({ status: resp.status, receipt, json }, null, 2));
console.log('HTTP', resp.status, 'receipt', receipt ? { success: receipt.success, transaction: receipt.transaction, network: receipt.network } : null);
for (const q of json.quotes || []) {
  const s = q.simulation || {};
  console.log(q.provider?.key, 'out', q.output?.amount, 'best', !!q.bestQuote,
    'sim', JSON.stringify({ ok: s.success ?? s.ok, err: s.error ?? s.err, gasless: s.gasless ?? q.gasless }).slice(0, 300));
}
if (!json.quotes) console.log(JSON.stringify(json).slice(0, 800));
