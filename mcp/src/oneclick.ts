// Minimal 1Click Swap API client (https://docs.near-intents.org). Using the 1Click API
// means accepting its Terms of Service; this code only runs when the person running the
// MCP server makes a cross-chain payment.
import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { canonicalChain } from "@agentguard/sdk";

export interface OneClickConfig {
  baseUrl: string;
  /** Optional partner JWT; without it 1Click adds a 0.25% fee. */
  jwt?: string;
}

interface Token {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
}

async function call<T>(cfg: OneClickConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cfg.jwt ? { authorization: `Bearer ${cfg.jwt}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`1Click ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** 1Click assetId for `symbol` on `chain` (AgentGuard chain name). */
export async function findAsset(cfg: OneClickConfig, chain: string, symbol: string): Promise<string> {
  const want = canonicalChain(chain);
  if (!want) throw new Error(`chain "${chain}" is not supported by NEAR Intents`);
  const tokens = await call<Token[]>(cfg, "/v0/tokens");
  const hits = tokens.filter((t) => t.blockchain === want && t.symbol.toUpperCase() === symbol.toUpperCase());
  if (hits.length === 0) throw new Error(`no ${symbol} on ${chain} in 1Click's token list`);
  // Several assets can share a symbol on one chain (native and bridged): never guess.
  if (hits.length > 1) {
    throw new Error(`${symbol} on ${chain} is ambiguous; pass destination_asset, one of: ${hits.map((t) => t.assetId).join(", ")}`);
  }
  return hits[0].assetId;
}

/**
 * A real (non-dry) EXACT_INPUT quote: `amount` of NEP-141 `token` deposited on NEAR is
 * delivered to `recipient` as `destinationAsset`; refunds go to `refundTo` on NEAR.
 * The signature is checked here too, before anything is trusted.
 */
export async function getQuote(
  cfg: OneClickConfig,
  p: { token: string; amount: string; destinationAsset: string; recipient: string; refundTo: string; slippageBps?: number },
): Promise<OneClickQuoteResponse> {
  const quote = await call<OneClickQuoteResponse>(cfg, "/v0/quote", {
    method: "POST",
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: p.slippageBps ?? 100,
      originAsset: `nep141:${p.token}`,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: p.destinationAsset,
      amount: p.amount,
      recipient: p.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: p.refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  });
  if (!verifyQuoteSignature(quote)) throw new Error("1Click quote signature did not verify");
  if (!quote.quote.depositAddress) throw new Error("1Click quote has no deposit address");
  return quote;
}

export async function swapStatus(cfg: OneClickConfig, depositAddress: string) {
  return call<{ status: string; swapDetails?: { destinationChainTxHashes?: { hash: string; explorerUrl: string }[] } }>(
    cfg,
    `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
  );
}
