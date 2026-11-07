# Security policy

AgentGuard is a spending firewall for AI agents. This repository holds a NEAR contract, a risk
oracle, an MCP server and a web app. It runs on **NEAR testnet only**: there is no mainnet
deployment and no real funds, so a testnet exploit costs nothing but is still worth reporting.

## Reporting a vulnerability

- **Preferred:** GitHub's private vulnerability reporting — the **Security** tab of this
  repository, then **Report a vulnerability**. It keeps the report private until a fix lands.
- **Fallback:** email `codemasterx@wearehackerone.com` with the steps to reproduce, the affected
  component and the impact you believe it has.

Please do not open a public issue for an exploitable bug. A first reply usually takes a few days.

## In scope

| Component | What matters |
|---|---|
| `contract/src/` | Policy enforcement, verdict checking (`attestation.rs`), vault funds, nonce handling, refunds, pause and withdraw |
| `oracle/src/` | Injection and look-alike detection, cross-chain quote binding, the optional LLM pass, the TEE gateway |
| `mcp/src/` | The four tools an agent calls, and what an agent can reach through them |
| `dashboard/src/` | XSS, unsafe links, anything that could make an owner approve the wrong payment |
| `tee-oracle/src/` | The decisions and signing path that run inside the enclave |

The most useful findings are ones that break a claim the README makes: a verdict that can be
forged, replayed, used after expiry or swapped onto another request; a policy limit that can be
crossed; a payment that reaches a recipient it should not; an injection the oracle scores as safe.

## Out of scope

- **Testnet funds and the demo vault.** Anyone may spend or approve what sits in vault 6.
- **Published test material.** The dev signer seed in the README example, the public 1Click manager
  key and the signature in `tee-oracle/testdata/` are deliberately public; see
  `tee-oracle/testdata/README.md`.
- **Third-party services** — OutLayer, NEAR RPC providers, FastNEAR's indexer — report those to
  their operators.
- **Rate limits, outages and the TEE binary's build provenance** in themselves; the documented
  hosting caveat is in `docs/TESTNET.md`.

## What is already tested

`103` tests across three suites, run in CI on every push: 47 for the contract (including forged,
replayed, expired and swapped verdicts, and the exact policy boundaries), 21 for the TEE
component, 35 for the SDK and oracle. `docs/THREAT_MODEL.md` lists 28 attacker scenarios, each
with its defence and the evidence for it (a unit test or script for 22 of them), and states the limitations we know about. A daily read-only job
checks that the deployed contract still matches the published code hash.

## Safe harbour

Research carried out in good faith on testnet, without attacking third-party infrastructure,
exfiltrating data or degrading the demo for other people, will not be met with legal action. Tell
us before you publish, and we will credit you if you want.
