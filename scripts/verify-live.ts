// Read-only check of what the site and docs claim: the deployed contract bytes, the demo
// vault, and how many events that vault has. No keys, no transactions: safe to run as a
// stranger, and it changes nothing on chain.
//
//   node --experimental-strip-types scripts/verify-live.ts
//
// Exit code 0 when the deployed code hash matches docs/TESTNET.md, 1 when it does not.
// Vault figures are reported against the README, but a mismatch there only means the demo
// vault was used since the README was written, so it is a warning and not a failure.

const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const TX_API = process.env.AGENTGUARD_TX_API ?? "https://tx.test.fastnear.com";
const CONTRACT = process.env.AGENTGUARD_CONTRACT ?? "guard.cm-agentguard.testnet";
const VAULT = Number(process.env.AGENTGUARD_VAULT_ID ?? 6);

/** docs/TESTNET.md, "Wasm (current)". */
const EXPECTED_CODE_SHA256 = "71fe3259550445fced074cbfff2495942eedd212fc32374a1ad95879d2d0943c";
/** README, "Open the app on the live demo vault". */
const EXPECTED = { balance: "270000000000000000000000", period: "250000000000000000000000", approval: "30000000000000000000000", pending: 2 };

let failures = 0;
const pass = (label: string, detail: string) => console.log(`PASS  ${label}  ${detail}`);
const warn = (label: string, detail: string) => console.log(`WARN  ${label}  ${detail}`);
const fail = (label: string, detail: string) => {
  failures++;
  console.log(`FAIL  ${label}  ${detail}`);
};

const b64toBytes = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

async function rpc(method: string, params: object) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
  });
  const body = (await res.json()) as { result?: any; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

async function view(methodName: string, args: object) {
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

const near = (raw: string) => `${(Number(raw) / 1e24).toFixed(2)} NEAR`;

async function main() {
  console.log(`contract ${CONTRACT}  vault ${VAULT}  rpc ${RPC}\n`);

  const account = await rpc("query", { request_type: "view_account", finality: "final", account_id: CONTRACT });
  const code = await rpc("query", { request_type: "view_code", finality: "final", account_id: CONTRACT });
  const bytes = b64toBytes(code.code_base64);
  const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  console.log(`code  ${bytes.length} bytes, sha256 ${digest}`);
  if (digest === EXPECTED_CODE_SHA256) pass("deployed code hash", "matches docs/TESTNET.md");
  else fail("deployed code hash", `docs/TESTNET.md says ${EXPECTED_CODE_SHA256}`);

  const v = await view("get_vault", { vault_id: VAULT });
  if (!v) {
    fail("vault", `no vault ${VAULT} on ${CONTRACT}`);
  } else {
    const limits = v.policy.tokens.near;
    const line = `${near(v.balances.near)} balance, ${near(limits.period_limit)} per ${v.policy.period_secs / 3600}h, auto-approve to ${near(limits.approval_threshold)}, ${v.pending.length} pending, paused=${v.paused}`;
    console.log(`vault ${line}`);
    for (const [key, got] of [
      ["balance", v.balances.near],
      ["period", limits.period_limit],
      ["approval", limits.approval_threshold],
    ] as const) {
      if (got === EXPECTED[key]) pass(`vault ${key}`, "matches README");
      else warn(`vault ${key}`, `README says ${EXPECTED[key]}, chain says ${got}`);
    }
    if (v.pending.length === EXPECTED.pending) pass("vault pending", "matches README");
    else warn("vault pending", `README says ${EXPECTED.pending}, chain says ${v.pending.length}`);
    if (v.paused === false) pass("vault pause", "not paused");
    else warn("vault pause", "paused: owner action since the README was written");
  }

  // Events: same source the dashboard reads, filtered to this vault.
  let token: string | undefined;
  let events = 0;
  for (let page = 0; page < 3; page++) {
    const body: Record<string, unknown> = { account_id: CONTRACT };
    if (token) body.resume_token = token;
    const res = await fetch(`${TX_API}/v0/account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      warn("events", `indexer HTTP ${res.status}`);
      break;
    }
    const { account_txs, resume_token } = (await res.json()) as { account_txs: { transaction_hash: string }[]; resume_token?: string };
    const hashes = [...new Set(account_txs.map((t) => t.transaction_hash))];
    for (let i = 0; i < hashes.length; i += 20) {
      const r = await fetch(`${TX_API}/v0/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx_hashes: hashes.slice(i, i + 20) }),
      });
      const { transactions } = (await r.json()) as { transactions: { receipts: { execution_outcome: { outcome: { executor_id: string; logs: string[] } } }[] }[] };
      for (const tx of transactions) {
        for (const rc of tx.receipts) {
          const o = rc.execution_outcome.outcome;
          if (o.executor_id !== CONTRACT) continue;
          for (const log of o.logs) {
            if (!log.startsWith("EVENT_JSON:")) continue;
            try {
              const e = JSON.parse(log.slice(11));
              const data = e.data?.[0] ?? {};
              const id = data.vault_id ?? data.request?.vault_id;
              if (e.standard === "agentguard" && id === VAULT && e.event !== "transfer_settled") events++;
            } catch {
              /* not ours */
            }
          }
        }
      }
    }
    token = resume_token;
    if (!token) break;
  }
  pass("vault events", `${events} agentguard events in the contract's recent history (the dashboard should list the same)`);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`could not verify: ${(e as Error).message}`);
  process.exit(2);
});
