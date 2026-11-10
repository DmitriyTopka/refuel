// dev/reset.mjs: test helper, NOT part of the skill. Puts the bot back to "0 SOL, only USDC".
// 1) normal (non-gasless) swap of SOL -> USDC through Hermes, the bot pays the network fee itself;
// 2) sweeps the last lamports to RETURN_TO so the bot ends at exactly 0 SOL.
import { createX402Client } from 'x402-solana/client';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

const RPC = 'https://api.mainnet-beta.solana.com';
const RETURN_TO = process.env.RETURN_TO; // where leftover SOL goes (the wallet that funded the bot)
if (!RETURN_TO) throw new Error('set RETURN_TO');
const w = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.PAYER_KEYPAIR, 'utf8'))));
const me = w.publicKey.toString();
const conn = new Connection(RPC, 'confirmed');
const c = createX402Client({ wallet: { address: me, signTransaction: async (t) => { t.sign([w]); return t; } }, network: 'solana', rpcUrl: RPC });
const post = async (p, b) => { const r = await c.fetch(`https://hermes.swap.io${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json() }; };

const RESERVE = 3_000_000; // keep 0.003 SOL for fees and the temporary wSOL account during the swap
let lam = await conn.getBalance(w.publicKey);
console.log('SOL before', lam / 1e9);
if (lam > RESERVE + 1_000_000) {
  const amount = String(lam - RESERVE);
  const q = await post('/v1/swap/quote-2.0', { input: { token: 'So11111111111111111111111111111111111111112', amount, chainKey: 'sol' }, output: { token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chainKey: 'sol' }, userAddress: me, slippageBps: 100 });
  const best = (q.json.quotes || []).find((x) => x.simulation?.success && x.simulation?.transaction);
  if (!best) throw new Error('no simulated quote ' + JSON.stringify(q.json).slice(0, 300));
  const b = { json: { transaction: best.simulation.transaction } };
  const t = VersionedTransaction.deserialize(Buffer.from(b.json.transaction, 'base64'));
  t.sign([w]);
  const req = t.message.header.numRequiredSignatures;
  console.log('required signers', req, t.message.staticAccountKeys.slice(0, req).map(String));
  const sres = await post('/v1/swap/submit-tx', { signedTransaction: Buffer.from(t.serialize()).toString('base64'), provider: best.provider.key, chainKey: 'sol' });
  const sig = sres.json.transactionHash;
  if (!sig) throw new Error('submit failed ' + JSON.stringify(sres.json).slice(0, 300));
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('swap SOL->USDC', best.provider.key, sig);
}
lam = await conn.getBalance(w.publicKey);
const fee = 5000;
if (lam > fee) {
  const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: new PublicKey(RETURN_TO), lamports: lam - fee }));
  const sig = await sendAndConfirmTransaction(conn, t, [w]);
  console.log('swept', (lam - fee) / 1e9, 'SOL to', RETURN_TO, sig);
}
console.log('SOL after', (await conn.getBalance(w.publicKey)) / 1e9);
