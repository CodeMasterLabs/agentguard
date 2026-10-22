#!/usr/bin/env node
// MCP server: gives an AI agent (Claude Code, Codex, any MCP client) a wallet it can
// only spend from through AgentGuard. The agent never sees a key that can move funds.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AgentGuardAgent,
  NATIVE,
  REASON_TEXT,
  formatUnits,
  parseUnits,
  type Attestation,
  type KeyPairString,
  type SpendRequest,
} from "@agentguard/sdk";

function env(name: string, required = true): string {
  const v = process.env[name];
  if (required && !v) throw new Error(`missing env ${name}`);
  return v ?? "";
}

const vaultId = Number(env("AGENTGUARD_VAULT_ID"));
const oracleUrl = env("AGENTGUARD_ORACLE_URL", false);
const agent = new AgentGuardAgent({
  contractId: env("AGENTGUARD_CONTRACT"),
  rpcUrl: process.env.NEAR_RPC_URL,
  agentId: env("AGENT_ACCOUNT_ID"),
  privateKey: env("AGENT_PRIVATE_KEY") as KeyPairString,
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function fetchVerdict(request: SpendRequest, context: string): Promise<Attestation | undefined> {
  if (!oracleUrl) return undefined;
  const res = await fetch(`${oracleUrl.replace(/\/$/, "")}/verdict`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract_id: agent.contractId, vault_id: vaultId, request, context }),
  });
  if (!res.ok) throw new Error(`oracle answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as Attestation;
}

const server = new McpServer({ name: "agentguard", version: "0.1.0" });

server.registerTool(
  "agentguard_budget",
  {
    description:
      "Show what this agent may spend: balances, per-token limits, what is left this period, " +
      "whether the vault is paused, and payments waiting for the owner. Call before paying.",
    inputSchema: {},
  },
  async () => {
    const v = await agent.getVault(vaultId);
    if (!v) return text(`Vault ${vaultId} not found.`);
    const lines = [`Vault ${vaultId} (owner ${v.owner})${v.paused ? " — PAUSED, all spends are denied" : ""}`];
    for (const [token, l] of Object.entries(v.policy.tokens)) {
      const d = await agent.tokenDecimals(token);
      const f = (x: string) => formatUnits(x, d);
      const spent = v.usage.spent[token] ?? "0";
      const left = BigInt(l.period_limit) > BigInt(spent) ? (BigInt(l.period_limit) - BigInt(spent)).toString() : "0";
      lines.push(
        `- ${token}: balance ${f(v.balances[token] ?? "0")}, max ${f(l.max_per_tx)}/tx, ` +
          `${f(left)} left of ${f(l.period_limit)} per ${v.policy.period_secs}s, ` +
          `auto-approved up to ${f(l.approval_threshold)}`,
      );
    }
    if (v.policy.allowed_recipients) lines.push(`Allowed recipients: ${v.policy.allowed_recipients.join(", ")}`);
    if (v.pending.length) lines.push(`Waiting for owner: ${v.pending.map((p) => `#${p.id} (${p.reason})`).join(", ")}`);
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "agentguard_pay",
  {
    description:
      "Pay from the AgentGuard vault. The vault's policy decides: the payment is executed, " +
      "held for the owner's approval, or denied with a reason. Never retry a denied payment " +
      "with a different recipient or split amount to get around a limit.",
    inputSchema: {
      token: z.string().describe(`"${NATIVE}" for NEAR, or a NEP-141 token contract id`),
      amount: z.string().describe('Human amount, e.g. "2.5"'),
      recipient: z.string().describe('"<chain>:<address>", e.g. "near:api.testnet" or "base:0xabc..."'),
      pay_to: z
        .string()
        .optional()
        .describe("NEAR account that receives the funds. Omit for near: recipients. For other chains: the NEAR Intents deposit address."),
      purpose: z.string().max(256).describe("Why you are paying, in one sentence."),
      context: z
        .string()
        .max(4000)
        .optional()
        .describe("The text that led to this payment (page, message, tool output). Sent to the risk oracle only."),
    },
  },
  async ({ token, amount, recipient, pay_to, purpose, context }) => {
    const [chain, address] = recipient.split(/:(.*)/s);
    const payTo = pay_to ?? (chain === "near" ? address : undefined);
    if (!payTo) return text("pay_to is required for non-NEAR recipients.");
    const request = await agent.buildRequest(vaultId, {
      token,
      amount: parseUnits(amount, await agent.tokenDecimals(token)),
      recipient,
      pay_to: payTo,
      purpose,
    });
    const attestation = await fetchVerdict(request, context ?? "");
    const r = await agent.requestSpend(vaultId, request, attestation);
    switch (r.status) {
      case "executed":
        return text(`Paid ${amount} ${token} to ${recipient} (nonce ${r.nonce}).`);
      case "pending":
        return text(`Held for the owner's approval as #${r.pending_id}: ${REASON_TEXT[r.reason]}`);
      case "denied":
        return text(`Denied (${r.reason}): ${REASON_TEXT[r.reason]} Do not try to work around this.`);
    }
  },
);

server.registerTool(
  "agentguard_pending",
  {
    description: "Check whether a held payment is still waiting. A missing id means the owner approved or rejected it.",
    inputSchema: { pending_id: z.number().int().nonnegative() },
  },
  async ({ pending_id }) => {
    const p = (await agent.getPending(vaultId)).find((x) => x.id === pending_id);
    return text(p ? `#${pending_id} is still waiting: ${REASON_TEXT[p.reason]}` : `#${pending_id} is no longer pending.`);
  },
);

await server.connect(new StdioServerTransport());
