// dev/show402.mjs: free, unpaid request to show the raw HTTP 402 and the price Swap.io asks for.
const r = await fetch('https://hermes.swap.io/v1/swap/quote-2.0', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input: { token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '2500000', chainKey: 'sol' },
    output: { token: 'So11111111111111111111111111111111111111112', chainKey: 'sol' },
    userAddress: 'rH6E3zfqaQyQ25Wij5yzmXydqKGWtvZA77fkQ3umcVJ', slippageBps: 100, gasless: true,
  }),
});
const j = await r.json();
const a = (j.accepts || []).find((x) => x.network === 'solana') || {};
const usd = (Number(a.maxAmountRequired) / 1e6).toFixed(4);
console.log(`HTTP ${r.status} Payment Required`);
console.log(`price: ${a.maxAmountRequired} atomic USDC = ${usd} USDC, pay to ${a.payTo}, network ${a.network}`);
