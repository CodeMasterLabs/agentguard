// WebMCP: tools an AI agent browsing this site can call (https://developer.chrome.com/docs/ai/webmcp).
// Read-only by design. Nothing here signs or moves funds: approvals, pause and withdraw stay
// behind the owner's wallet, so an agent can look but never act for the owner.
import { formatUnits } from "@agentguard/sdk/dist/units.js";
import { REASON_TEXT } from "@agentguard/sdk/dist/types.js";
import { getVault, view, type Network, type PendingSpend } from "./near";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
};
type ModelContext = {
  registerTool?: (tool: Tool) => unknown;
  unregisterTool?: (name: string) => unknown;
  provideContext?: (ctx: { tools: Tool[] }) => unknown;
};

/** Names this page has registered, so a remount does not register them twice. */
const registered = new Set<string>();

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError } : {}),
});

const amount = (token: string, raw: string) => (token === "near" ? `${formatUnits(raw, 24)} NEAR` : `${raw} (base units of ${token})`);

const vaultArgs = {
  type: "object",
  properties: {
    vault_id: { type: "integer", minimum: 0, description: "Vault id, e.g. 6 for the public demo vault." },
    contract: { type: "string", description: "AgentGuard contract account. Defaults to the one this page shows." },
  },
  required: ["vault_id"],
  additionalProperties: false,
};

/** Registers the tools if the browser supports WebMCP; returns a cleanup function. */
export function registerWebMcpTools(env: { network: Network; contract: string; openVault: (contract: string, vaultId: number) => void }) {
  const mc = ((navigator as unknown as { modelContext?: ModelContext }).modelContext ??
    (document as unknown as { modelContext?: ModelContext }).modelContext) as ModelContext | undefined;
  if (!mc) return () => {};

  const target = (input: Record<string, unknown>) => ({
    contract: typeof input.contract === "string" && input.contract ? input.contract : env.contract,
    vaultId: Number(input.vault_id),
  });

  const tools: Tool[] = [
    {
      name: "agentguard_get_vault",
      description:
        "Read an AgentGuard vault on NEAR: owner, agent, balances, spending limits, usage this period, paused state and how many payments wait for approval. Read-only.",
      inputSchema: vaultArgs,
      annotations: { readOnlyHint: true },
      async execute(input) {
        const { contract, vaultId } = target(input);
        try {
          const v = await getVault(env.network, contract, vaultId);
          if (!v) return text(`No vault ${vaultId} on ${contract}.`, true);
          return text({
            vault_id: vaultId,
            contract,
            network: env.network,
            owner: v.owner,
            agent: v.agent,
            paused: v.paused,
            balances: Object.fromEntries(Object.entries(v.balances).map(([t, raw]) => [t, amount(t, raw)])),
            limits: Object.fromEntries(
              Object.entries(v.policy.tokens).map(([t, l]) => [
                t,
                { per_payment: amount(t, l.max_per_tx), per_period: amount(t, l.period_limit), auto_approve_up_to: amount(t, l.approval_threshold) },
              ]),
            ),
            period_hours: v.policy.period_secs / 3600,
            max_requests_per_hour: v.policy.max_requests_per_hour,
            payments_waiting: v.pending.length,
          });
        } catch (e) {
          return text(`Could not read the vault: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "agentguard_list_pending",
      description:
        "List the payments an AgentGuard vault is holding for the owner's approval, with amount, recipient, the agent's stated purpose and why each was held. Read-only.",
      inputSchema: vaultArgs,
      annotations: { readOnlyHint: true },
      async execute(input) {
        const { contract, vaultId } = target(input);
        try {
          const pending = await view<PendingSpend[]>(env.network, contract, "get_pending", { vault_id: vaultId });
          return text(
            pending.map((p) => ({
              id: p.id,
              amount: amount(p.request.token, p.request.amount),
              recipient: p.request.recipient,
              purpose: p.request.purpose,
              held_because: REASON_TEXT[p.reason] ?? p.reason,
            })),
          );
        } catch (e) {
          return text(`Could not read held payments: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "agentguard_open_vault",
      description: "Open a vault's dashboard page in this tab so the person can review it. Approving or rejecting still needs the owner's wallet.",
      inputSchema: vaultArgs,
      async execute(input) {
        const { contract, vaultId } = target(input);
        if (!Number.isInteger(vaultId) || vaultId < 0) return text("vault_id must be a non-negative integer.", true);
        env.openVault(contract, vaultId);
        return text(`Opened vault ${vaultId} on ${contract}.`);
      },
    },
  ];

  if (mc.registerTool) {
    // A second mount (React StrictMode runs effects twice) must not register the same name
    // again: the browser rejects duplicates with InvalidStateError.
    for (const t of tools) {
      if (registered.has(t.name)) continue;
      try {
        mc.registerTool(t);
        registered.add(t.name);
      } catch {
        /* another instance already owns this name */
      }
    }
    return () => {
      for (const t of tools) if (registered.delete(t.name)) mc.unregisterTool?.(t.name);
    };
  }
  mc.provideContext?.({ tools });
  return () => mc.provideContext?.({ tools: [] });
}
