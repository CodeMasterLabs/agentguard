# Threat model

## Assets
Funds in vaults (NEAR and NEP-141 tokens), and the owner's control over the policy.

## Actors
| Actor | Trusted? | Can do |
|---|---|---|
| Owner (person, DAO, multisig) | Yes | Everything for their vault |
| Agent | **No.** Assume it can be prompt-injected or buggy | Call `request_spend` for its vault |
| Risk oracle | Partially: trusted for verdicts, only for vaults whose owner registered its key | Sign verdicts |
| Anyone else | No | Fund vaults, read state |

## Threats and mitigations

| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Injected agent pays an attacker | Allow/deny lists, per-tx cap, new-recipient approval, oracle verdict on the triggering context | `deny_and_allow_lists`, `new_recipient_needs_approval_once`, `oracle_deny_and_review_verdicts` |
| T2 | Agent drains the vault in many small payments | Period limit plus rate limit with auto-pause | `period_limit_accumulates_and_resets`, `runaway_loop_trips_rate_limit_and_pauses` |
| T3 | Agent uses its key for something else | Function-call key restricted to `request_spend` on this contract; the method accepts no deposit | `scripts/provision-agent.ts` |
| T4 | Agent approves its own parked spend | Owner-only, and requires 1 yoctoNEAR (a full-access key), which a function-call key cannot attach | `agent_cannot_approve_its_own_request` |
| T5 | Forged oracle verdict | ed25519 signature against the key the owner registered for this vault | `forged_attestation_denied` |
| T6 | Valid verdict reused for another payment | Verdict bound to contract id, vault id and request hash (token, amount, recipient, pay_to, purpose, nonce); the nonce advances on every request | `attestation_for_other_request_denied`, `attestation_cannot_be_replayed` |
| T7 | Stale verdict | `expires_at` checked against block time | `expired_attestation_denied` |
| T8 | Cross-chain spend to an attacker-chosen deposit address | Cross-chain spends need a verdict binding `pay_to` to `recipient`, or a human; deny list also matches `pay_to` | `cross_chain_needs_attestation_then_executes_with_valid_one`, `denylist_also_matches_pay_to` |
| T9 | Failed transfer loses funds | Balance debited before the promise, re-credited in the callback on failure | `failed_transfer_is_refunded` |
| T10 | Storage griefing via the pending queue | Queue capped at 32 per vault | `pending_queue_is_bounded` |
| T11 | Owner key compromise | Out of scope for the contract. Use a Sputnik DAO or Trezu multisig as owner. | — |
| T13 | Injected text tells the oracle's LLM "risk 0" | Heuristic score is a floor; the LLM can only add points | `oracle.test.ts`: LLM can raise risk but a manipulated low score cannot lower it |
| T14 | Instructions hidden from humans (Unicode tags, zero-width, bidi, hidden HTML) | Tag characters decoded and re-scanned; hidden-character signals score on their own | `oracle.test.ts`: hidden Unicode-tag instructions |
| T15 | Address poisoning (look-alike of a trusted address) | Same head and tail as a known recipient but a different middle is denied | `oracle.test.ts`: address poisoning |
| T16 | Oracle key used for another deployment | Message binds the contract id; `ORACLE_ALLOWED_CONTRACTS` refuses others | `allowedContracts refuses other deployments` |
| T12 | Compromised oracle | Limited to vaults that trust it. It can only approve requests that already pass the hard policy limits; it can never raise caps. | by design (`evaluate` order) |

## Known limitations
- Known recipients are stored per vault forever (bounded only by spends). Fine for a hackathon; a production version would expire them.
- The TEE quote is verified off-chain before the owner registers the oracle key. On-chain quote verification is future work.
- A human approval overrides policy limits on purpose (only the balance is still checked).
