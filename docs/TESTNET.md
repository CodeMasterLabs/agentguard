# Testnet deployment

| What | Value |
|---|---|
| Contract | [`guard.cm-agentguard.testnet`](https://testnet.nearblocks.io/address/guard.cm-agentguard.testnet) |
| Owner used for the runs below | `cm-agentguard.testnet` |
| Wasm | CI artifact `agentguard-wasm` from commit `3b310c5`, built by `cargo near build` (v0.22.0) |
| Wasm sha256 | `6d5d23660fc74ad11675ee4589269bd90fa2372935498b3c1f378943c0e20737` |
| RPC | `https://rpc.testnet.fastnear.com` (`rpc.testnet.near.org` is deprecated and rate-limits) |

## End-to-end run

`scripts/e2e-testnet.ts` creates a fresh payee (an account with no keys), an agent whose only key is limited to `request_spend`, a local risk oracle with a fresh key, and a vault funded with 1 NEAR. It then runs every scenario against the live contract.

```bash
OWNER_ID=<you>.testnet AGENTGUARD_CONTRACT=guard.cm-agentguard.testnet \
  node --experimental-strip-types scripts/e2e-testnet.ts
```

Output from the 2026-10-22 run (vault 2):

```
PASS  new recipient is held for approval  {"status":"pending","pending_id":0,"reason":"new_recipient"}
PASS  owner approval pays the recipient  +0.05 NEAR
PASS  known recipient + oracle allow executes  {"status":"executed","nonce":1}
PASS  recipient received the funds  +0.05 NEAR
PASS  prompt injection is denied  {"status":"denied","reason":"oracle_denied"}
PASS  over per-tx cap is denied  {"status":"denied","reason":"over_per_tx_cap"}
PASS  over approval threshold is held  {"status":"pending","pending_id":1,"reason":"over_approval_threshold"}
PASS  rejected spend leaves balance untouched  unchanged
PASS  paused vault denies everything  {"status":"denied","reason":"paused"}
PASS  agent key cannot transfer directly  Access key requires full access
PASS  runaway loop trips the rate limit  {"status":"denied","reason":"rate_limited"}
PASS  rate limit auto-paused the vault  paused
PASS  owner withdraws the remainder while paused  892000000000000000000000 yocto

ALL PASSED  vault 2 on guard.cm-agentguard.testnet
```

The 0.892 NEAR left in the vault is exactly 1 − 0.05 − 0.05 − 8 × 0.001: the two paid invoices and the eight 0.001 payments the "runaway loop" made before the rate limit tripped. Every denied or rejected request moved nothing.

## MCP server against the live contract

Vault 3 with an agent created by `scripts/provision-agent.ts`, driven through the MCP server over stdio:

```
tools: agentguard_budget, agentguard_pay, agentguard_pending

[budget]
Vault 3 (owner cm-agentguard.testnet)
- near: balance 0.3, max 0.1/tx, 0.2 left of 0.2 per 86400s, auto-approved up to 0.05

[pay new recipient]
Held for the owner's approval as #0: First payment to this recipient; waiting for the owner.

[pay over cap]
Denied (over_per_tx_cap): Amount is above the per-transaction cap. Do not try to work around this.
```

## Gas note

Prepaid gas is reserved from the agent's balance and key allowance at a pessimistic price before refunds arrive, so many back-to-back calls can exhaust a small balance. The SDK prepays 50 Tgas for `request_spend`, and `provision-agent.ts` funds agents with 0.5 NEAR and a 1 NEAR allowance.
