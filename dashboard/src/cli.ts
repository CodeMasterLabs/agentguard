// near-cli-rs commands for every owner action, so nothing in the dashboard needs the dashboard.
// Shared by the docs page and the vault page (which fills in its own vault and owner).
import type { Network } from "./near";

export const CLI_INSTALL = `npm install -g near-cli-rs
near account import-account using-web-wallet network-config testnet`;

const json = (args: unknown) => JSON.stringify(args);

export function cliView(contract: string, network: Network, method: string, args: unknown) {
  return `near contract call-function as-read-only ${contract} ${method} \\
  json-args '${json(args)}' network-config ${network} now`;
}

/** Owner calls need 1 yoctoNEAR (a full-access key confirms them), except pause and deposits. */
export function cliCall(contract: string, network: Network, signer: string, method: string, args: unknown, deposit = "1 yoctoNEAR", jsonArgs?: string) {
  return `near contract call-function as-transaction ${contract} ${method} \\
  json-args ${jsonArgs ?? `'${json(args)}'`} \\
  prepaid-gas '100 Tgas' attached-deposit '${deposit}' \\
  sign-as ${signer} network-config ${network} sign-with-keychain send`;
}

export type CliOp = { title: string; note?: string; code: string };

/** Every owner operation, in the order an owner meets them. */
export function ownerOps(contract: string, network: Network, vaultId: number, owner: string, pendingId: number | string = 0): CliOp[] {
  const v = { vault_id: vaultId };
  return [
    { title: "See the vault", note: "Balances, policy, usage, paused state.", code: cliView(contract, network, "get_vault", v) },
    { title: "See held payments", note: "Each has an id, the request and the reason it was held.", code: cliView(contract, network, "get_pending", v) },
    { title: "Approve a held payment", code: cliCall(contract, network, owner, "approve_pending", { ...v, pending_id: pendingId }) },
    { title: "Reject a held payment", code: cliCall(contract, network, owner, "reject_pending", { ...v, pending_id: pendingId }) },
    { title: "Kill switch", note: "No deposit, so any of your keys can do it.", code: cliCall(contract, network, owner, "pause", v, "0 NEAR") },
    { title: "Resume", code: cliCall(contract, network, owner, "unpause", v) },
    {
      title: "Withdraw 0.1 NEAR",
      note: "Amounts are in base units (1 NEAR = 10²⁴ yocto). Works while paused.",
      code: cliCall(contract, network, owner, "withdraw", { ...v, token: "near", amount: "100000000000000000000000", to: null }),
    },
    { title: "Add 1 NEAR", code: cliCall(contract, network, owner, "deposit_near", v, "1 NEAR") },
    {
      title: "Change the policy",
      note: "Reads a policy file, e.g. scripts/demo-policy.json (needs jq).",
      code: cliCall(contract, network, owner, "update_policy", null, undefined, `"$(jq -c '{vault_id: ${vaultId}, policy: .}' policy.json)"`),
    },
    { title: "Revoke the agent", note: "Pass an account id instead of null to set a new one.", code: cliCall(contract, network, owner, "set_agent", { ...v, agent: null }) },
  ];
}

export function createVaultCmd(contract: string, network: Network, owner: string) {
  return cliCall(contract, network, owner, "create_vault", null, "0.5 NEAR", `"$(jq -c '{policy: ., agent: null, oracle_pk: null}' scripts/demo-policy.json)"`);
}
