# Testnet deployment

| What | Value |
|---|---|
| Contract | [`guard.cm-agentguard.testnet`](https://testnet.nearblocks.io/address/guard.cm-agentguard.testnet) |
| Owner used for the runs below | `cm-agentguard.testnet` |
| Wasm (current) | `cargo near build non-reproducible-wasm --no-abi` (v0.22.0), sha256 `6c96df99e00387f9cec5602ee77a37ebd7b60554925d2a831b8e2f0a2e7e9f02`. Upgraded in place; existing vaults kept their state. |
| Wasm (first deploy) | CI artifact `agentguard-wasm` from commit `3b310c5`, sha256 `6d5d23660fc74ad11675ee4589269bd90fa2372935498b3c1f378943c0e20737` |
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

The same run passed again on the upgraded contract (vault 5).

## Cross-chain (NEAR Intents) run

1Click runs on mainnet only, so `scripts/e2e-intents-testnet.ts` signs quotes with a **test** manager key that this run's oracle trusts. Everything else is real: `wrap.testnet`, NEP-145 registration of a fresh deposit address, the token transfer, the oracle's binding checks and the contract's attestation check.

```bash
OWNER_ID=<you>.testnet AGENTGUARD_CONTRACT=guard.cm-agentguard.testnet \
  node --experimental-strip-types scripts/e2e-intents-testnet.ts
```

Output from the 2026-10-22 run (vault 4):

```
PASS  vault funded with wNEAR via ft_transfer_call  40000000000000000000000 wNEAR, 20000000000000000000000 NEAR
PASS  valid 1Click quote: oracle allows  []
PASS  valid 1Click quote: contract executes  {"status":"executed","nonce":0}
PASS  deposit address received the wNEAR  10000000000000000000000
PASS  registration fee (0.00125 NEAR) came from the vault  20000000000000000000000 -> 18750000000000000000000
PASS  refunds to the agent: denied  ["refunds do not go back to the vault owner"]
PASS  pay_to swapped after quoting: denied  {"status":"denied","reason":"oracle_denied"}
PASS  no quote: held for the owner  {"status":"pending","pending_id":0,"reason":"oracle_review"}
PASS  owner withdrew wNEAR and NEAR  both 0

ALL PASSED  vault 4 on guard.cm-agentguard.testnet
```

Not covered on testnet: 1Click's real servers and signing key. The verifier uses the official SDK's `verifyQuoteSignature`, which defaults to 1Click's production key.

## Oracle in OutLayer's TEE

| What | Value |
|---|---|
| OutLayer project | `cm-agentguard.testnet/agentguard-oracle` on `outlayer.testnet` |
| Component | `tee-oracle/`, `wasm32-wasip2`, sha256 `4c9a9e05185a4425a7ca2609f9f8eb6e40ffd84e9e05e421eaeac2d91a463e4e` |
| Published at | `https://test.fastfs.io/cm-agentguard.testnet/outlayer.testnet/4c9a9e05185a4425a7ca2609f9f8eb6e40ffd84e9e05e421eaeac2d91a463e4e.wasm` (hash re-checked after upload) |

**Verified locally** with `tee-oracle/harness`, on wasmtime 28 (the OutLayer worker's version) and with stand-in signing-key and RPC host functions. The component instantiates; `public_key` answers; a prompt injection gets `deny`, score 105 with the same signals as the TypeScript oracle; a cross-chain request reads the vault owner through `near:rpc`; and a quote edited after signing is denied.

**Not yet verified live.** On 2026-10-22 every `request_execution` (txs `5z9jRhst…`, `2drf31Zm…`, `59T4cQ4P…`) resolved our exact version and then came back with `Execution promise failed`, charging only the 0.001 NEAR base fee. OutLayer's `/public/workers` showed the testnet executors restarting every 30 to 60 seconds, including while we sent nothing. No testnet job had been recorded since request 5445 the day before. When the executors are stable:

```bash
OWNER_ID=<you>.testnet AGENTGUARD_CONTRACT=guard.cm-agentguard.testnet \
OUTLAYER_PROJECT=cm-agentguard.testnet/agentguard-oracle \
  node --experimental-strip-types scripts/e2e-tee-testnet.ts
```

That run gets the TEE key with its attestation, registers it on a fresh vault, and checks that the contract accepts TEE-signed verdicts: a benign payment executes, an injection is refused, and a payment with no verdict waits for the owner.

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
