#!/usr/bin/env node
// refuel.mjs: lets a Solana agent that ran out of SOL refuel itself from USDC.
//
// It pays the Swap.io Hermes Agent API per request over x402 (USDC, gasless for the payer),
// asks for a gasless swap (Swap.io sponsors the network fee and takes a small cut of the output),
// signs the prebuilt transaction locally and submits it. No account, no API key, no SOL needed.
//
// Commands (JSON-ish lines to stdout, progress to stderr):
//   check                                   free: SOL and USDC balance of the wallet
//   refuel [--usdc 3] [--min-sol 0.002] [--yes] [--force]
//                                           paid: quote-2.0 with gasless:true, then (with --yes) sign and submit
//   fail-demo                               paid-path request with a broken mint: shows 4xx and that nothing is charged
//
// Env: PAYER_KEYPAIR (path to Solana keypair JSON, required), SOLANA_RPC_URL, HERMES_URL.
// Builds on the swap-dot-io/agent-skills hermes-swap plugin (same x402 client and receipt check),
// adds gasless swaps, balance trigger and on-chain confirmation. The secret key is never printed.
import { createX402Client } from 'x402-solana/client';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

const HERMES = process.env.HERMES_URL || 'https://hermes.swap.io';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1e9;

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue;
  const k = rest[i].slice(2); const v = rest[i + 1];
  if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; }
}
const say = (...x) => console.log(...x);
const fail = (m) => { console.error(`ERROR: ${m}`); process.exit(1); };
const tx = (sig) => `https://solscan.io/tx/${sig}`;

function loadWallet() {
  const p = process.env.PAYER_KEYPAIR || process.env.CLAUDE_PLUGIN_OPTION_PAYER_KEYPAIR;
  if (!p) fail('set PAYER_KEYPAIR to a Solana keypair JSON file (dedicated wallet, a few USDC)');
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, 'utf8'))));
}
const conn = new Connection(RPC, 'confirmed');

async function balances(pub) {
  const sol = await conn.getBalance(pub);
  const ta = await conn.getParsedTokenAccountsByOwner(pub, { mint: new PublicKey(USDC) });
  const usdc = ta.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  return { sol: sol / LAMPORTS, usdc };
}

function client(w) {
  return createX402Client({
    wallet: { address: w.publicKey.toString(), signTransaction: async (t) => { t.sign([w]); return t; } },
    network: 'solana', rpcUrl: RPC,
  });
}

// Paid POST: trust a 200 only with a successful settlement receipt (X-PAYMENT-RESPONSE).
async function paid(c, path, body) {
  console.error(`-> POST ${HERMES}${path}`);
  const r = await c.fetch(`${HERMES}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const h = r.headers.get('x-payment-response');
  const receipt = h ? JSON.parse(Buffer.from(h, 'base64').toString()) : null;
  let json = null; try { json = await r.json(); } catch { json = null; }
  return { status: r.status, receipt, json };
}

async function main() {
  if (cmd === 'check') {
    const w = loadWallet(); const b = await balances(w.publicKey);
    say(JSON.stringify({ wallet: w.publicKey.toString(), sol: b.sol, usdc: b.usdc }));
    return;
  }

  if (cmd === 'fail-demo') {
    const w = loadWallet(); const c = client(w);
    const before = await balances(w.publicKey);
    // the broken mint is deliberate: shows "no route = no charge"
    const r = await paid(c, '/v1/swap/quote', {
      input: { token: 'NotARealMint1111111111111111111111111111111', amount: '1000000', chainKey: 'sol' },
      output: { token: SOL, chainKey: 'sol' }, userAddress: w.publicKey.toString(), slippageBps: 100,
    });
    const after = await balances(w.publicKey);
    say(JSON.stringify({ http: r.status, receipt: r.receipt, error: r.json?.error || r.json?.message || r.json, usdcBefore: before.usdc, usdcAfter: after.usdc, charged: after.usdc < before.usdc }));
    return;
  }

  if (cmd === 'refuel') {
    const w = loadWallet(); const me = w.publicKey.toString(); const c = client(w);
    const minSol = Number(args['min-sol'] ?? 0.002);
    const usdcIn = Number(args.usdc ?? 3);
    if (usdcIn < 2) fail('Swap.io gasless swaps need at least $2 of input');
    const b = await balances(w.publicKey);
    say(`wallet ${me}`);
    say(`balance: ${b.sol} SOL, ${b.usdc} USDC`);
    if (b.sol >= minSol && !args.force) { say(`SOL is above ${minSol}, no refuel needed`); return; }
    if (b.usdc < usdcIn + 0.01) fail(`need ${usdcIn + 0.01} USDC, have ${b.usdc}`);
    say(`out of gas: ${b.sol} SOL < ${minSol}. Buying a gasless quote from Swap.io...`);

    const q = await paid(c, '/v1/swap/quote-2.0', {
      input: { token: USDC, amount: String(Math.round(usdcIn * 1e6)), chainKey: 'sol' },
      output: { token: SOL, chainKey: 'sol' }, userAddress: me, slippageBps: 100, gasless: true,
    });
    if (q.status !== 200 || !q.receipt?.success) fail(`quote not settled: HTTP ${q.status} ${JSON.stringify(q.json).slice(0, 300)}`);
    say(`paid for the quote, receipt: ${tx(q.receipt.transaction)}`);
    const quotes = q.json.quotes || [];
    for (const x of quotes) {
      const s = x.simulation || {};
      say(`  ${x.bestQuote ? '*' : ' '} ${String(x.provider?.key).padEnd(8)} ${s.primaryOutput?.amountFormatted ?? '-'} SOL  simulation ${s.success ? 'ok' : 'failed'}  gasless ${s.gasless?.enabled ? 'yes' : 'no'}`);
    }
    const best = quotes.find((x) => x.bestQuote && x.simulation?.success) || quotes.find((x) => x.simulation?.success);
    if (!best?.simulation?.transaction) fail('no provider returned a simulated transaction');
    if (!best.simulation.gasless?.enabled) fail('gasless is not available for this swap (Swap.io needs SOL < 0.01 and at least $2)');
    say(`best route: ${best.provider.key}, ${best.simulation.primaryOutput.amountFormatted} SOL, network fee sponsored by ${best.simulation.gasless.feePayer}`);
    if (!args.yes) { say('dry run: add --yes to sign and send'); return; }

    const t = VersionedTransaction.deserialize(Buffer.from(best.simulation.transaction, 'base64'));
    t.sign([w]);
    const s = await paid(c, '/v1/swap/submit-tx', {
      signedTransaction: Buffer.from(t.serialize()).toString('base64'), provider: best.provider.key, chainKey: 'sol',
    });
    if (s.status !== 200 || !s.json?.transactionHash) fail(`submit failed: HTTP ${s.status} ${JSON.stringify(s.json).slice(0, 300)}`);
    say(`swap sent: ${tx(s.json.transactionHash)}`);
    let st = null;
    for (let i = 0; i < 30; i++) {
      st = (await conn.getSignatureStatuses([s.json.transactionHash])).value[0];
      if (st && (st.err || ['confirmed', 'finalized'].includes(st.confirmationStatus))) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (st?.err) fail(`swap failed on chain: ${JSON.stringify(st.err)}`);
    const a = await balances(w.publicKey);
    say(`refueled: ${a.sol} SOL, ${a.usdc} USDC (${st?.confirmationStatus || 'pending'})`);
    return;
  }

  say('usage: refuel.mjs check | refuel [--usdc 3] [--min-sol 0.002] [--yes] | fail-demo');
}
main().catch((e) => fail(e.message));
