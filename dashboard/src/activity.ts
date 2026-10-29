// A vault's history, rebuilt from the contract's own NEP-297 events. The contract keeps no
// history in state, so this reads recent transactions to the contract from FastNEAR's
// transaction API and keeps the events of one vault. Read-only and best effort: an indexer
// outage hides the log, never the vault.
import type { Network } from "./near";

const TX_API: Record<Network, string> = {
  testnet: "https://tx.test.fastnear.com",
  mainnet: "https://tx.main.fastnear.com",
};
/** The API's per-request cap. */
const BATCH = 20;
/** Transactions to the whole contract, newest first; enough for a demo-sized deployment. */
const SCAN = 60;

export type ActivityEvent =
  | "spend_executed"
  | "spend_pending"
  | "spend_denied"
  | "pending_approved"
  | "pending_rejected"
  | "vault_paused"
  | "vault_unpaused"
  | "withdrawn"
  | "deposited"
  | "policy_updated"
  | "agent_set"
  | "oracle_set"
  | "vault_created"
  | "transfer_failed_refunded";

export type Activity = {
  /** Receipt id plus position, unique per event. */
  key: string;
  event: ActivityEvent;
  /** Block time in ms. */
  at: number;
  tx: string;
  data: Record<string, any>;
};

type Receipt = { execution_outcome: { id: string; block_timestamp: number; outcome: { logs: string[]; executor_id: string } } };
type Tx = { transaction: { hash: string }; receipts: Receipt[] };

async function post<T>(network: Network, path: string, body: object): Promise<T> {
  const res = await fetch(`${TX_API[network]}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const vaultOf = (d: Record<string, any>): number | undefined => d.vault_id ?? d.request?.vault_id;

/** Recent events of one vault, newest first. Settled transfers are left out: they follow every payment. */
export async function getActivity(network: Network, contract: string, vaultId: number): Promise<Activity[]> {
  const { account_txs } = await post<{ account_txs: { transaction_hash: string }[] }>(network, "/v0/account", { account_id: contract });
  const hashes = account_txs.slice(0, SCAN).map((t) => t.transaction_hash);
  const batches: string[][] = [];
  for (let i = 0; i < hashes.length; i += BATCH) batches.push(hashes.slice(i, i + BATCH));
  const txs = (await Promise.all(batches.map((b) => post<{ transactions: Tx[] }>(network, "/v0/transactions", { tx_hashes: b })))).flatMap(
    (r) => r.transactions,
  );

  const out: Activity[] = [];
  for (const tx of txs) {
    for (const r of tx.receipts) {
      const o = r.execution_outcome;
      if (o.outcome.executor_id !== contract) continue;
      o.outcome.logs.forEach((log, i) => {
        if (!log.startsWith("EVENT_JSON:")) return;
        try {
          const e = JSON.parse(log.slice(11)) as { standard: string; event: string; data: Record<string, any>[] };
          const data = e.data?.[0];
          if (e.standard !== "agentguard" || !data || vaultOf(data) !== vaultId || e.event === "transfer_settled") return;
          out.push({ key: `${o.id}:${i}`, event: e.event as ActivityEvent, at: Math.floor(o.block_timestamp / 1e6), tx: tx.transaction.hash, data });
        } catch {
          /* not one of ours */
        }
      });
    }
  }
  // Newest first; events of one receipt keep their log order reversed with it.
  return out.sort((a, b) => b.at - a.at || b.key.localeCompare(a.key));
}
