#!/usr/bin/env node
// agentguard-watch: tells the owner when a vault holds a payment or pauses, so nobody has to
// keep the dashboard open. Polls the contract (read-only, no keys) and sends each alert to
// ntfy, a webhook (Slack, Discord or any JSON endpoint) or Telegram.
import { AgentGuardViewer, REASON_TEXT, formatUnits, type PendingSpend, type Vault } from "@agentguard/sdk";

function env(name: string, required = true): string {
  const v = process.env[name];
  if (required && !v) throw new Error(`missing env ${name}`);
  return v ?? "";
}

const contractId = env("AGENTGUARD_CONTRACT");
const vaultIds = env("AGENTGUARD_VAULT_ID")
  .split(",")
  .map((v) => Number(v.trim()));
if (vaultIds.some((v) => !Number.isInteger(v) || v < 0)) throw new Error("AGENTGUARD_VAULT_ID: one vault id, or several separated by commas");
const intervalMs = Math.max(5, Number(process.env.ALERT_INTERVAL_SECS || 30)) * 1000;
const ntfyUrl = env("ALERT_NTFY_URL", false);
const webhookUrl = env("ALERT_WEBHOOK_URL", false);
const telegramToken = env("TELEGRAM_BOT_TOKEN", false);
const telegramChat = env("TELEGRAM_CHAT_ID", false);
const dashboardUrl = env("AGENTGUARD_DASHBOARD_URL", false).replace(/\/$/, "");
/** Also alert on what is already waiting when the watcher starts. */
const alertExisting = process.env.ALERT_EXISTING === "1";

const viewer = new AgentGuardViewer({ contractId, rpcUrl: process.env.NEAR_RPC_URL });
const decimals = new Map<string, number>();

async function amountText(token: string, raw: string): Promise<string> {
  if (!decimals.has(token)) decimals.set(token, await viewer.tokenDecimals(token).catch(() => -1));
  const d = decimals.get(token)!;
  return d < 0 ? `${raw} base units of ${token}` : `${formatUnits(raw, d)} ${token === "near" ? "NEAR" : token}`;
}

const link = (vaultId: number) => (dashboardUrl ? `${dashboardUrl}/?contract=${contractId}&vault=${vaultId}#/app` : "");

async function send(title: string, body: string, url: string) {
  console.log(`[${new Date().toISOString()}] ${title}: ${body}${url ? ` ${url}` : ""}`);
  const jobs: Promise<unknown>[] = [];
  if (ntfyUrl) {
    const headers: Record<string, string> = { Title: title, Tags: "warning", Priority: "high" };
    if (url) headers.Click = url;
    jobs.push(fetch(ntfyUrl, { method: "POST", headers, body }));
  }
  if (webhookUrl) {
    // `text` for Slack, `content` for Discord; other endpoints get every field.
    const text = `*${title}*\n${body}${url ? `\n${url}` : ""}`;
    jobs.push(fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text, title, body, url }) }));
  }
  if (telegramToken && telegramChat) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: telegramChat, text: `${title}\n${body}${url ? `\n${url}` : ""}`, disable_web_page_preview: true }),
      }),
    );
  }
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "rejected") console.error(`alert not delivered: ${(r.reason as Error).message}`);
    else if (r.value instanceof Response && !r.value.ok) console.error(`alert not delivered: HTTP ${r.value.status}`);
  }
}

async function pendingAlert(vaultId: number, s: PendingSpend) {
  const r = s.request;
  const to = r.recipient.startsWith("near:") ? r.recipient.slice(5) : r.recipient;
  const amount = await amountText(r.token, r.amount);
  const lines = [`To ${to}`, REASON_TEXT[s.reason], r.purpose ? `Agent's reason: "${r.purpose}"` : ""].filter(Boolean);
  await send(`Vault #${vaultId}: payment waiting, ${amount}`, `${lines.join("\n")}\nApprove or reject it in the dashboard (held payment #${s.id}).`, link(vaultId));
}

type Seen = { pending: Set<number>; paused: boolean };
const state = new Map<number, Seen>();

async function check(vaultId: number) {
  const v: Vault | null = await viewer.getVault(vaultId);
  if (!v) throw new Error(`no vault #${vaultId} on ${contractId}`);
  const before = state.get(vaultId);
  state.set(vaultId, { pending: new Set(v.pending.map((s) => s.id)), paused: v.paused });
  if (!before) {
    console.log(`watching vault #${vaultId}: ${v.pending.length} waiting, ${v.paused ? "paused" : "active"}`);
    if (!alertExisting) return;
  }
  for (const s of v.pending) if (!before?.pending.has(s.id)) await pendingAlert(vaultId, s);
  if (v.paused && before && !before.paused) await send(`Vault #${vaultId} paused`, "Every spend is refused until you resume it.", link(vaultId));
}

if (!ntfyUrl && !webhookUrl && !(telegramToken && telegramChat)) {
  console.log("No alert channel set (ALERT_NTFY_URL, ALERT_WEBHOOK_URL or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID); printing alerts here only.");
}

async function tick() {
  for (const id of vaultIds) {
    try {
      await check(id);
    } catch (e) {
      console.error(`vault #${id}: ${(e as Error).message}`);
    }
  }
}

await tick();
setInterval(tick, intervalMs);
