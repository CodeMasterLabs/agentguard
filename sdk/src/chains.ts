// Chain names as used in AgentGuard recipients (`base:0x…`) versus NEAR Intents / 1Click.

const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "eth", eth: "eth", arbitrum: "arb", arb: "arb", base: "base", optimism: "op", op: "op",
  polygon: "pol", pol: "pol", avalanche: "avax", avax: "avax", bsc: "bsc", gnosis: "gnosis",
  solana: "sol", sol: "sol", bitcoin: "btc", btc: "btc", ton: "ton", tron: "tron", sui: "sui",
  doge: "doge", xrp: "xrp", zec: "zec", bera: "bera", aptos: "aptos", cardano: "cardano", stellar: "stellar",
};

/** 1Click's `blockchain` name for an AgentGuard chain name, if supported. */
export function canonicalChain(chain: string): string | undefined {
  return CHAIN_ALIASES[chain.toLowerCase()];
}

/**
 * Destination chain of a bridged 1Click assetId such as `nep141:eth.omft.near` or
 * `nep141:base-0x833589….omft.near`. Undefined when it cannot be told from the id.
 */
export function assetChain(assetId: string): string | undefined {
  const m = /^nep141:([a-z0-9]+)(?:-[^.]+)?\.omft\.near$/i.exec(assetId);
  return m ? canonicalChain(m[1]) : undefined;
}
