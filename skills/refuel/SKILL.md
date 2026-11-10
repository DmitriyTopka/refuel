---
name: refuel
description: Refuel a Solana agent wallet that ran out of SOL for fees, using only the USDC it holds. Pays the Swap.io Hermes Agent API per request over x402 and requests a gasless swap, so it works from exactly 0 SOL. Use when a Solana transaction fails with insufficient SOL for fees, when the user says the bot or agent is out of gas, or asks to top up SOL from USDC.
---

# refuel: get SOL back from USDC, starting at 0 SOL

An agent wallet with USDC but no SOL is stuck: every Solana transaction, including a swap, normally needs SOL for the fee. This skill gets out of that loop:

1. Buys a quote from Swap.io Hermes (`/v1/swap/quote-2.0`, about $0.004) and pays for it with x402. The payment is gasless for the payer: the x402 facilitator pays the network fee.
2. Asks for `gasless: true`. Swap.io sponsors the swap's network fee and takes a small cut of the SOL output. Conditions from Swap.io: wallet SOL below 0.01 and swap of at least $2.
3. Signs the prebuilt transaction from the best route locally and submits it through `/v1/swap/submit-tx` (about $0.003, charged only after the network accepts it).

No account, no API key, no subscription. Every paid response carries an on-chain receipt (`X-PAYMENT-RESPONSE`), printed as a Solscan link.

## Setup

- `npm install` in the skill's root folder.
- A dedicated wallet with a few USDC. Export `PAYER_KEYPAIR=/path/to/keypair.json`. Never print or commit the key.

## Commands

    node refuel.mjs check                      # free: SOL and USDC balance
    node refuel.mjs refuel --usdc 3            # paid quote, shows routes, dry run
    node refuel.mjs refuel --usdc 3 --yes      # sign and send the gasless swap
    node refuel.mjs fail-demo                  # broken mint: 4xx, nothing charged

`refuel` does nothing if SOL is already above `--min-sol` (default 0.002).

## Rules for the agent

- Show the user the route table and the expected SOL before running with `--yes`.
- Never move more USDC than the user allowed. Never print the keypair.
- If the quote shows `gasless no`, stop and tell the user why (SOL above 0.01 or less than $2).
