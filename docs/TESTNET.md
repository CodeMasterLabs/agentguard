# Testnet deployment

| What | Value |
|---|---|
| Contract | [`guard.cm-agentguard.testnet`](https://testnet.nearblocks.io/address/guard.cm-agentguard.testnet) ([explorer](https://explorer.testnet.near.org/accounts/guard.cm-agentguard.testnet)) |
| Owner used for the runs below | `cm-agentguard.testnet` |
| Wasm (current) | `cargo near build non-reproducible-wasm --no-abi` (v0.22.0), sha256 `71fe3259550445fced074cbfff2495942eedd212fc32374a1ad95879d2d0943c` (adds: `withdraw` refuses 0 and settles storage). Upgraded in place 2026-10-29; the policy suite passes 13/13 on it (vault 12). |
| Wasm (audit fixes) | sha256 `a44eee48e6066edc2fca3af81e3f12f8e3505c3193dba2539dc5a0fae4e4bc0d` (per-vault storage accounting, policy caps, canonical recipients); both suites passed on it (vaults 9 and 10). |
| Wasm (first deploy) | CI artifact `agentguard-wasm` from commit `3b310c5`, sha256 `6d5d23660fc74ad11675ee4589269bd90fa2372935498b3c1f378943c0e20737` |
| RPC | `https://rpc.testnet.fastnear.com` (`rpc.testnet.near.org` is deprecated and rate-limits) |

## End-to-end run

`scripts/e2e-testnet.ts` creates a fresh payee (an account with no keys), an agent whose only key is limited to `request_spend`, a local risk oracle with a fresh key, and a vault funded with 1 NEAR. It then runs every scenario against the live contract.

**To re-run it yourself:** an owner account you control on testnet holding a few NEAR, its key in the near-cli keychain at `~/.near-credentials/testnet/<OWNER_ID>.json`, a deployed contract, and a built oracle (`npm run build -w oracle`, because the script imports `oracle/dist/signer.js`). Each run creates accounts and spends 0.05 to 0.1 NEAR per scenario. The PASS lines below are the archived output of the runs on the dates shown; the same command on a funded account regenerates them.

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
| Component | `tee-oracle/`, `wasm32-wasip2`, sha256 `d6ca6abde6a504d51b7975cbf830f9bf737cb91bbffaa9c46d0f50aeead59984` (includes the audit fixes) |
| Published at | [`CodeMasterLabs/agentguard-tee-oracle` release v0.1.0](https://github.com/CodeMasterLabs/agentguard-tee-oracle/releases/tag/v0.1.0) (hash re-checked after upload) |
| Built from | `agentguard-tee-oracle` commit `eb38e11` (the commit the v0.1.0 release page pins). A build of `tee-oracle/` at a later commit of this repo will not match that digest: the look-alike rule was widened after the release, so the bytes differ by design until the component is released again. |
| TEE verdict key | `379254656f69463816e2ae98250d71f21d581e98914034b074d7720e3e9d68fe`, bound to the project and its caller |

```bash
OWNER_ID=<you>.testnet AGENTGUARD_CONTRACT=guard.cm-agentguard.testnet OUTLAYER_PROJECT=cm-agentguard.testnet/agentguard-oracle   node --experimental-strip-types scripts/e2e-tee-testnet.ts
```

The run gets the TEE key with its attestation, registers it as the only oracle of a fresh vault, and checks that the contract accepts verdicts decided and signed inside the TEE. Output from the 2026-10-29 run (vault 11):

```
TEE verdict key 379254656f69463816e2ae98250d71f21d581e98914034b074d7720e3e9d68fe
attestation https://testnet-api.outlayer.ai/attestations/by-tx/G7GreX2mcBH2p5MNmQUeYXSoTtVN6rHB4Yxb4ss9WXM4
vault 11: every spend >= 0.001 NEAR needs a TEE verdict

PASS  TEE allows a benign payment  []
PASS  contract accepts the TEE-signed verdict  {"status":"executed","nonce":0}
      attestation https://testnet-api.outlayer.ai/attestations/by-tx/grgzDwgr1hJb5Vyvf3DvMvKkG6tpiepPfjuUMTAj74g
PASS  TEE denies a prompt injection  ["instruction_override","secrecy_demand","payment_demand","urgency_pressure","payee_from_suspicious_text"]
PASS  contract refuses it  {"status":"denied","reason":"oracle_denied"}
PASS  without a TEE verdict it waits for the owner  {"status":"pending","pending_id":0,"reason":"needs_attestation"}

ALL PASSED  vault 11 on guard.cm-agentguard.testnet, oracle in TEE (cm-agentguard.testnet/agentguard-oracle)
```

**Also verified locally** with `tee-oracle/harness`, on wasmtime 28 (the OutLayer worker's version) with stand-in signing-key and RPC host functions.

**Why the WASM is on GitHub, not FastFS.** From 2026-10-21 to about 10-26, OutLayer's testnet workers ran only WASM they had already cached ([out-layer/outlayer#32](https://github.com/out-layer/outlayer/issues/32)). Once that recovered, testnet FastFS (`test.fastfs.io`, `*.testnet.fastfs.io`) was still returning 502, so a FastFS-hosted version failed with `wasm_url could not be fetched` (tx `9ZRfRtDi9bqx31PvxL9XzHdCnp5eBzx545YbNf8gesae`). OutLayer accepts any HTTPS URL plus a sha256, so the build is served from a GitHub release and the worker checks the hash.

**Note for testers: the GitHub release is the WASM's only hosting.** GitHub serves release files from a CDN (`release-assets.githubusercontent.com`) behind a redirect, so a rate limit or a network that blocks that domain can fail a run with the same `wasm_url could not be fetched` error. If that happens, it is a hosting failure, not the oracle or the contract:

- Retry after a minute; GitHub's rate limits are short-lived.
- A worker that already has version `d6ca6abde6a504d51b7975cbf830f9bf737cb91bbffaa9c46d0f50aeead59984` cached runs it regardless.
- OutLayer accepts any HTTPS URL plus the sha256, so the same WASM can be re-published from any host and deployed as a new pinned version if GitHub becomes unreachable from the worker.

## MCP server against the live contract

Vault 3 with an agent created by `scripts/provision-agent.ts`, driven through the MCP server over stdio. The transcript is from an earlier build that exposed three tools; the current server adds `agentguard_swap_status`, so it lists four.

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
