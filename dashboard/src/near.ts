// Chain access for the dashboard: views over plain JSON-RPC (no wallet needed), owner
// actions through the connected wallet (NEAR Connect). The SDK's Node-only parts are not
// imported here; only its types, units and reason texts.
import type { NearConnector } from "@hot-labs/near-connect";
import type { PendingSpend, Policy, Vault } from "@agentguard/sdk/dist/types.js";

export type Network = "testnet" | "mainnet";

export const RPC: Record<Network, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

const TGAS = "000000000000";
const ONE_YOCTO = "1";

export async function view<T>(network: Network, contractId: string, method: string, args: object): Promise<T> {
  const res = await fetch(RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "agentguard",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(body.error?.data ?? body.error?.message ?? body.result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
}

// A read started before the dashboard's code arrives (see prefetchVault), used once by its first load.
let early: { key: string; at: number; result: Promise<Vault | null> } | undefined;

export function getVault(n: Network, c: string, vaultId: number): Promise<Vault | null> {
  const key = `${n}/${c}/${vaultId}`;
  if (early?.key === key && Date.now() - early.at < 10_000) {
    const { result } = early;
    early = undefined;
    return result;
  }
  return view<Vault | null>(n, c, "get_vault", { vault_id: vaultId });
}

/** Start reading a vault now, in parallel with loading the page that shows it. */
export function prefetchVault(n: Network, c: string, vaultId: number) {
  const result = view<Vault | null>(n, c, "get_vault", { vault_id: vaultId });
  result.catch(() => {}); // the page's own load reports errors
  early = { key: `${n}/${c}/${vaultId}`, at: Date.now(), result };
}
export const getVaultsOf = (n: Network, c: string, owner: string) => view<number[]>(n, c, "get_vaults_of", { owner });

const decimalsCache = new Map<string, number>();
export async function tokenDecimals(n: Network, token: string): Promise<number> {
  if (token === "near") return 24;
  if (!decimalsCache.has(token)) {
    const meta = await view<{ decimals: number }>(n, token, "ft_metadata", {});
    decimalsCache.set(token, meta.decimals);
  }
  return decimalsCache.get(token)!;
}

// ---- wallet ----

// The wallet library is loaded on first use, so pages that only read never download it.
let connector: { network: Network; ready: Promise<NearConnector> } | undefined;
export function getConnector(network: Network): Promise<NearConnector> {
  if (!connector || connector.network !== network) {
    const ready = import("@hot-labs/near-connect").then(({ NearConnector }) => new NearConnector({ network, providers: { [network]: [RPC[network]] } }));
    connector = { network, ready };
  }
  return connector.ready;
}

/** One owner action on the vault contract. Every owner method but `pause` takes 1 yoctoNEAR. */
async function ownerCall(network: Network, contractId: string, methodName: string, args: object, deposit = ONE_YOCTO) {
  const wallet = await (await getConnector(network)).wallet();
  return wallet.signAndSendTransaction({
    receiverId: contractId,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: `100${TGAS}`, deposit } }],
  });
}

export const actions = {
  approve: (n: Network, c: string, vault_id: number, pending_id: number) => ownerCall(n, c, "approve_pending", { vault_id, pending_id }),
  reject: (n: Network, c: string, vault_id: number, pending_id: number) => ownerCall(n, c, "reject_pending", { vault_id, pending_id }),
  // The kill switch takes no deposit, so it works even from a limited key.
  pause: (n: Network, c: string, vault_id: number) => ownerCall(n, c, "pause", { vault_id }, "0"),
  unpause: (n: Network, c: string, vault_id: number) => ownerCall(n, c, "unpause", { vault_id }),
  setAgent: (n: Network, c: string, vault_id: number, agent: string | null) => ownerCall(n, c, "set_agent", { vault_id, agent }),
  updatePolicy: (n: Network, c: string, vault_id: number, policy: Policy) => ownerCall(n, c, "update_policy", { vault_id, policy }),
  withdraw: (n: Network, c: string, vault_id: number, token: string, amount: string) =>
    ownerCall(n, c, "withdraw", { vault_id, token, amount, to: null }),
  setOracle: (n: Network, c: string, vault_id: number, oracle_pk: string | null) => ownerCall(n, c, "set_oracle", { vault_id, oracle_pk }),
  depositNear: (n: Network, c: string, vault_id: number, yocto: string) => ownerCall(n, c, "deposit_near", { vault_id }, yocto),
  /**
   * Creates a vault owned by the signer. The deposit pays the vault's storage (a few
   * milliNEAR, measured by the contract) and the rest is its balance. Returns the new id:
   * from the call's return value when the wallet hands back the outcome, else the newest
   * vault the signer owns.
   */
  async createVault(n: Network, c: string, owner: string, policy: Policy, agent: string | null, yocto: string): Promise<number> {
    const before = new Set(await getVaultsOf(n, c, owner).catch(() => [] as number[]));
    const outcome = (await ownerCall(n, c, "create_vault", { policy, agent, oracle_pk: null }, yocto)) as
      | { status?: { SuccessValue?: string } }
      | undefined;
    const ret = outcome?.status?.SuccessValue;
    if (ret) {
      const id = Number(atob(ret));
      if (Number.isInteger(id)) return id;
    }
    const after = await getVaultsOf(n, c, owner);
    const fresh = after.filter((v) => !before.has(v));
    if (!fresh.length) throw new Error("The vault was created but its id could not be read; find it under Your vaults.");
    return Math.max(...fresh);
  },
};

export type { PendingSpend, Policy, Vault };
