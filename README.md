# refuel

A Claude Code skill and a small Node script that lets a Solana agent refuel itself when it runs out of SOL, using only USDC and the [Swap.io](https://swap.io) Hermes Agent API paid over [x402](https://x402.org).

Starting point: a wallet with **0 SOL** and a few USDC. Result: SOL back on the wallet, network fee sponsored by Swap.io, about one cent of API fees.

```
$ node refuel.mjs refuel --usdc 2.5 --yes
balance: 0 SOL, 3.141153 USDC
out of gas: 0 SOL < 0.002. Buying a gasless quote from Swap.io...
paid for the quote, receipt: https://solscan.io/tx/5T9oyswt...Tpr8qD1E
  * dflow    0.027699536 SOL  simulation ok  gasless yes
    zerox    0.027699369 SOL  simulation ok  gasless yes
    jupiter  0.027694113 SOL  simulation ok  gasless yes
swap sent: https://solscan.io/tx/36vLV6cJ...WdarufhstV39
refueled: 0.027699439 SOL, 0.634463 USDC (finalized)
```

Receipts from the run in the video:
- x402 payment for the quote: https://solscan.io/tx/5T9oyswt5QP2DJdrMFcP4NiDCSHoEebJpEosJT7xadP6wNxwR51YBdJPDiWLd9mj3wSWvPhNWJkmVnUNTpr8qD1E
- the gasless swap: https://solscan.io/tx/36vLV6cJdmD8pMUr35hYDNEvJ7X1CzwGBAQpMF6KAfmkmB98JSeVkwkwY8ib5m4t3FVw67aQNghUWdarufhstV39

Video: [link to the X post, added after publishing]

Why x402 here and not an API key: the skill is public and runs on other people's machines. A key would have to ship with it or every user would need to sign up. With x402 each install pays for its own calls from its own wallet, fractions of a cent, and nobody holds anyone's key.

See `skills/refuel/SKILL.md` for commands and agent rules. Built on top of the [hermes-swap plugin](https://github.com/swap-dot-io/agent-skills) by Swap.io (same x402 client and receipt check), adding gasless swaps, a balance trigger and on-chain confirmation.

`dev/reset.mjs` is a test helper that puts the wallet back to 0 SOL; it is not part of the skill.

## Safety

The skill holds a real key, so it does not trust the server blindly:
- Every x402 payment is capped (`MAX_PAY_ATOMIC`, default 10000 = $0.01) and must go to the pinned Swap.io `payTo`, in USDC, on Solana mainnet. Otherwise the payment is refused before anything is signed.
- A custom `HERMES_URL` is refused unless you also pin its `HERMES_PAY_TO`.
- Before signing the swap, the script simulates it on your own RPC and refuses it unless the fee payer is the pinned Swap.io sponsor, the wallet loses at most the requested USDC and no SOL, and no token account gets closed, re-owned or delegated.

## Known limits

- Solana mainnet only. The wallet needs a few USDC to start.
- Swap.io sponsors the swap fee only when the wallet has under 0.01 SOL and the swap is worth $2 or more, so the default is 2.5 USDC.
- The keypair is a local file. Keep it out of the repo (`.gitignore` covers `*keypair*.json`).
- Quotes live for a short time, so the skill signs and sends right after paying.
- The pre-sign check covers classic SPL token accounts. Use a dedicated wallet that holds only USDC for the bot.

## How it was built

I wrote this with Claude Code as my pair, then ran every command above on mainnet with a real wallet.

MIT license.
