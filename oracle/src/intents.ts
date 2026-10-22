// Binding verifier for cross-chain payments through NEAR Intents (1Click Swap API).
//
// The agent asks the contract to pay `pay_to` (a 1Click deposit address on NEAR) for a
// beneficiary `recipient` on another chain. The contract cannot see where a deposit address
// leads. 1Click signs every quote; for real (non-dry) quotes the signed payload includes the
// deposit address. So: if a quote signed by 1Click says "tokens sent to `pay_to` are swapped
// and delivered to `recipient`", with refunds going to the vault owner, the binding holds.
import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { assetChain, canonicalChain, type SpendRequest } from "@agentguard/sdk";

export type IntentsQuote = OneClickQuoteResponse;

export interface BindingOptions {
  /** NEAR account(s) refunds may go to. Normally the vault owner. */
  refundAccounts: string[];
  /** Defaults to 1Click's production manager key in the SDK. Override only in tests. */
  managerPublicKey?: string;
  /** Max value lost between input and output in USD terms, in bps (slippage + all fees). */
  maxValueLossBps?: number;
  /** The quote must stay valid at least this long after now. */
  minDeadlineSecs?: number;
  now?: () => number;
}

export interface BindingResult {
  ok: boolean;
  /** Why the binding failed, one entry per broken check. */
  problems: string[];
}

export { assetChain, canonicalChain };

/**
 * The oracle's `verifyBinding` dependency: looks up the vault owner on-chain (refunds may
 * only go there) and checks the quote. The verdict TTL must not outlive the quote.
 */
export function intentsBinder(opts: {
  getVaultOwner: (contractId: string, vaultId: number) => Promise<string>;
  managerPublicKey?: string;
  maxValueLossBps?: number;
  verdictTtlSecs: number;
}) {
  return async (input: { contract_id: string; vault_id: number; request: SpendRequest; intents_quote?: IntentsQuote }) => {
    if (!input.intents_quote) return { ok: false, problems: ["no quote"] };
    const owner = await opts.getVaultOwner(input.contract_id, input.vault_id);
    return verifyBinding(input.request, input.intents_quote, {
      refundAccounts: [owner],
      managerPublicKey: opts.managerPublicKey,
      maxValueLossBps: opts.maxValueLossBps,
      minDeadlineSecs: opts.verdictTtlSecs,
    });
  };
}

const sameAddress =(a: string, b: string) => (a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);

export function verifyBinding(req: SpendRequest, quote: IntentsQuote, opts: BindingOptions): BindingResult {
  const problems: string[] = [];
  const q = quote.quoteRequest;
  const res = quote.quote;
  const [chain, address] = [req.recipient.slice(0, req.recipient.indexOf(":")), req.recipient.slice(req.recipient.indexOf(":") + 1)];

  if (!verifyQuoteSignature(quote, opts.managerPublicKey)) problems.push("quote signature is not 1Click's");
  if (q.dry !== false || !res.depositAddress) problems.push("quote is a dry run without a deposit address");
  if (res.depositAddress !== req.pay_to) problems.push("pay_to is not the quote's deposit address");
  if (res.depositMemo) problems.push("quote needs a deposit memo, which the vault cannot attach");
  if (q.depositType !== "ORIGIN_CHAIN") problems.push("deposit type must be ORIGIN_CHAIN");

  if (req.token === "near") problems.push("native NEAR cannot fund a 1Click deposit; hold wrap.near in the vault");
  if (q.originAsset !== `nep141:${req.token}`) problems.push(`origin asset ${q.originAsset} does not match token ${req.token}`);
  if (q.swapType !== "EXACT_INPUT" || q.amount !== req.amount || res.amountIn !== req.amount) {
    problems.push("quote must be EXACT_INPUT for exactly the requested amount");
  }

  if (q.recipientType !== "DESTINATION_CHAIN" || !sameAddress(q.recipient, address)) {
    problems.push("quote does not deliver to the requested recipient");
  }
  const want = canonicalChain(chain);
  const got = assetChain(q.destinationAsset);
  if (!want || !got || want !== got) problems.push(`destination asset ${q.destinationAsset} is not on ${chain}`);
  if (q.virtualChainRecipient || q.customRecipientMsg) problems.push("quote redirects delivery (virtual chain or custom message)");

  if (q.refundType !== "ORIGIN_CHAIN" || !opts.refundAccounts.includes(q.refundTo)) {
    problems.push("refunds do not go back to the vault owner");
  }

  const nowMs = (opts.now ?? Date.now)();
  const deadline = Date.parse(res.deadline ?? q.deadline);
  if (!(deadline > nowMs + (opts.minDeadlineSecs ?? 60) * 1000)) problems.push("quote deadline is too close or passed");

  // appFees are not covered by the signature, but the USD values are: cap total value loss.
  const inUsd = Number(res.amountInUsd);
  const outUsd = Number(res.amountOutUsd);
  const maxLoss = (opts.maxValueLossBps ?? 300) / 10_000;
  if (!(inUsd > 0) || !(outUsd >= inUsd * (1 - maxLoss))) {
    problems.push(`swap loses more than ${(maxLoss * 100).toFixed(1)}% of value (in $${res.amountInUsd}, out $${res.amountOutUsd})`);
  }
  return { ok: problems.length === 0, problems };
}
