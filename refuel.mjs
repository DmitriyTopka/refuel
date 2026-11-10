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
// Env: PAYER_KEYPAIR (path to Solana keypair JSON, required), SOLANA_RPC_URL, HERMES_URL,
//      MAX_PAY_ATOMIC (cap per x402 payment, default 10000 = $0.01), HERMES_PAY_TO, GASLESS_SPONSOR.
//
// Safety: every x402 payment is capped and must go to the pinned Swap.io payTo in USDC on Solana mainnet.
// The swap transaction from the server is simulated on your own RPC before signing: it must be paid by the
// Swap.io sponsor, take at most the requested USDC, leave your SOL and token accounts with you, no delegate.
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
const DEFAULT_HERMES = 'https://hermes.swap.io';
// pinned from https://hermes.swap.io/v1/info and the 402 answers seen on mainnet (Nov 2026)
const PAY_TO = process.env.HERMES_PAY_TO || 'BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD';
const SPONSOR = process.env.GASLESS_SPONSOR || 'E4BV2sQb7jMDpjfDqLNhCMqLTdSgq4Zcgszr9naUqRyC';
const MAX_PAY = BigInt(process.env.MAX_PAY_ATOMIC || '10000');

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

if (HERMES !== DEFAULT_HERMES && !process.env.HERMES_PAY_TO) {
  console.error('ERROR: custom HERMES_URL needs HERMES_PAY_TO too, so payments cannot go to an unknown address'); process.exit(1);
}

// x402 payment policy: runs after the 402 is parsed and before anything is signed.
function paymentPolicy(req, ctx) {
  const no = (reason) => ({ abort: true, reason });
  if (!ctx.requestUrl.startsWith(HERMES + '/')) return no(`unexpected URL ${ctx.requestUrl}`);
  if (req.payTo !== PAY_TO) return no(`payTo ${req.payTo} is not the pinned Swap.io address`);
  if (req.asset !== USDC) return no(`asset ${req.asset} is not USDC`);
  if (!String(req.network).startsWith('solana') || String(req.network).includes('devnet')) return no(`network ${req.network} is not Solana mainnet`);
  if (BigInt(req.amount) > MAX_PAY) return no(`price ${req.amount} is above the cap ${MAX_PAY}`);
}

function client(w) {
  return createX402Client({
    wallet: { address: w.publicKey.toString(), signTransaction: async (t) => { t.sign([w]); return t; } },
    network: 'solana', rpcUrl: RPC, amount: MAX_PAY, beforePayment: paymentPolicy,
  });
}

// SPL token account base layout (same for Token and Token-2022): mint 0..32, owner 32..64, amount 64..72,
// delegate option 72..108, state 108, isNative option 109..121, delegatedAmount 121..129, closeAuthority option 129..165
function tokenState(b64) {
  if (!b64) return null;
  const d = Buffer.from(b64, 'base64');
  if (d.length < 165) return null;
  const closeAuth = d.readUInt32LE(129) !== 0 ? new PublicKey(d.subarray(133, 165)).toString() : null;
  return { mint: new PublicKey(d.subarray(0, 32)).toString(), owner: new PublicKey(d.subarray(32, 64)).toString(),
    amount: d.readBigUInt64LE(64), delegated: d.readUInt32LE(72) !== 0, state: d[108], closeAuth };
}
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

// Check the server-built swap before signing it. Throws with a reason if anything looks wrong.
async function verifySwap(t, me, maxUsdcAtomic, minSolLamports) {
  const keys = t.message.staticAccountKeys;
  const feePayer = keys[0].toString();
  if (feePayer === me) throw new Error('fee payer is our wallet, not the gasless sponsor');
  if (feePayer !== SPONSOR) throw new Error(`fee payer ${feePayer} is not the pinned Swap.io sponsor`);
  // a durable nonce would let the transaction run later than the simulation we check; the swap must use a normal blockhash
  const first = t.message.compiledInstructions[0];
  if (first && keys[first.programIdIndex]?.toString() === '11111111111111111111111111111111' && first.data.length >= 4 && Buffer.from(first.data).readUInt32LE(0) === 4)
    throw new Error('the swap uses a durable nonce');
  const pub = new PublicKey(me);
  const tokenAccs = (await Promise.all(TOKEN_PROGRAMS.map((id) => conn.getTokenAccountsByOwner(pub, { programId: new PublicKey(id) })))).flatMap((r) => r.value);
  const addrs = [me, ...tokenAccs.map((a) => a.pubkey.toString())];
  const pre = Object.fromEntries(tokenAccs.map((a) => [a.pubkey.toString(), tokenState(Buffer.from(a.account.data).toString('base64'))]));
  const preSol = await conn.getBalance(pub);
  const sim = await conn.simulateTransaction(t, { sigVerify: false, replaceRecentBlockhash: true, accounts: { addresses: addrs, encoding: 'base64' } });
  if (sim.value.err) throw new Error(`own RPC simulation failed: ${JSON.stringify(sim.value.err)}`);
  const post = sim.value.accounts;
  if ((post[0]?.lamports ?? 0) < preSol) throw new Error('the swap would take SOL from the wallet');
  if (post[0] && post[0].owner !== '11111111111111111111111111111111') throw new Error('the swap would reassign the wallet account');
  let usdcOut = 0n;
  addrs.slice(1).forEach((a, i) => {
    const after = tokenState(post[i + 1]?.data?.[0]); const before = pre[a];
    if (!after) throw new Error(`the swap would close token account ${a}`);
    if (after.owner !== me) throw new Error(`the swap would change the owner of token account ${a}`);
    if (after.delegated) throw new Error(`the swap would set a delegate on token account ${a}`);
    if (after.state !== before.state) throw new Error(`the swap would freeze or change the state of token account ${a}`);
    if (after.closeAuth !== before.closeAuth && after.closeAuth !== me) throw new Error(`the swap would give the close authority of ${a} to someone else`);
    if (after.amount < before.amount) {
      if (after.mint !== USDC) throw new Error(`the swap would take a non-USDC token from ${a}`);
      usdcOut += before.amount - after.amount;
    }
  });
  if (usdcOut > maxUsdcAtomic) throw new Error(`the swap would take ${usdcOut} atomic USDC, asked for ${maxUsdcAtomic}`);
  const gain = (post[0]?.lamports ?? 0) - preSol;
  if (gain < minSolLamports) throw new Error(`the swap would add only ${gain} lamports, the quote promised at least ${minSolLamports}`);
  return { usdcOut, solGain: ((post[0]?.lamports ?? 0) - preSol) / LAMPORTS };
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
    const t = VersionedTransaction.deserialize(Buffer.from(best.simulation.transaction, 'base64'));
    // the simulation must deliver at least the quoted SOL minus 2% (slippage 1% plus the gasless cut)
    const minGain = Math.floor(Number(best.simulation.primaryOutput.amount) * 0.98);
    const v = await verifySwap(t, me, BigInt(Math.round(usdcIn * 1e6)), minGain);
    console.error(`checked on own RPC: takes ${Number(v.usdcOut) / 1e6} USDC, adds ${v.solGain} SOL, fee paid by sponsor`);
    if (!args.yes) { say('dry run: add --yes to sign and send'); return; }
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
