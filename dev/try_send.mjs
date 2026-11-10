// dev/try_send.mjs: shows the real network error a 0-SOL wallet gets when it tries any transaction.
// Tries to send 1 lamport to itself. Nothing can be charged: the wallet has no SOL.
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
const w = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.PAYER_KEYPAIR, 'utf8'))));
const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
console.log(`$ send any transaction from ${w.publicKey.toString().slice(0, 8)}... with 0 SOL`);
try {
  const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: w.publicKey, lamports: 1 }));
  t.feePayer = w.publicKey;
  t.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  t.sign(w);
  const sim = await conn.simulateTransaction(t);
  if (sim.value.err) console.log('ERROR from the network:', JSON.stringify(sim.value.err), '(the fee payer has no SOL)');
  else console.log('simulation ok (unexpected)');
} catch (e) {
  console.log('ERROR:', String(e.message || e).replace(/\s+/g, ' ').slice(0, 160));
}
