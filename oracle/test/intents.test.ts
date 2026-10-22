// Cross-chain binding: quotes are signed here with a TEST manager key using the 1Click SDK's
// own quoteHash, so the verifier runs the same code path it runs against real 1Click quotes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { base58 } from "@scure/base";
import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import type { SpendRequest } from "@agentguard/sdk";
import { assetChain, intentsBinder, verifyBinding, type IntentsQuote } from "../dist/intents.js";
import { decide, type OracleDeps } from "../dist/service.js";
import { OracleSigner } from "../dist/signer.js";

const seed = Buffer.alloc(32, 9);
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
const MANAGER = `ed25519:${base58.encode(spki.subarray(spki.length - 32))}`;

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DEPOSIT = "5f".repeat(32);
const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

function signQuote(q: IntentsQuote): IntentsQuote {
  const sig = sign(null, new TextEncoder().encode(quoteHash(q)), priv);
  return { ...q, signature: `ed25519:${base58.encode(sig)}` };
}

function quote(over: { req?: Record<string, unknown>; quote?: Record<string, unknown> } = {}): IntentsQuote {
  return signQuote({
    correlationId: "test",
    timestamp: "2026-11-05T12:00:00.000Z",
    signature: "",
    quoteRequest: {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:wrap.near",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_BASE,
      amount: "1000000000000000000000000",
      refundTo: "owner.near",
      refundType: "ORIGIN_CHAIN",
      recipient: RECIPIENT,
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-05T12:10:00.000Z",
      ...over.req,
    },
    quote: {
      depositAddress: DEPOSIT,
      amountIn: "1000000000000000000000000",
      amountInFormatted: "1",
      amountInUsd: "2.50",
      minAmountIn: "1000000000000000000000000",
      amountOut: "2470000",
      amountOutFormatted: "2.47",
      amountOutUsd: "2.47",
      minAmountOut: "2440000",
      deadline: "2026-11-05T12:10:00.000Z",
      timeEstimate: 30,
      ...over.quote,
    },
  } as unknown as IntentsQuote);
}

const req = (over: Partial<SpendRequest> = {}): SpendRequest => ({
  token: "wrap.near",
  amount: "1000000000000000000000000",
  recipient: `base:${RECIPIENT}`,
  pay_to: DEPOSIT,
  purpose: "Pay the GPU provider on Base",
  nonce: 7,
  ...over,
});

const opts = { refundAccounts: ["owner.near"], managerPublicKey: MANAGER, now: () => NOW };

test("assetChain reads the destination chain from omft asset ids", () => {
  assert.equal(assetChain(USDC_BASE), "base");
  assert.equal(assetChain("nep141:eth.omft.near"), "eth");
  assert.equal(assetChain("nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near"), "arb");
  assert.equal(assetChain("nep141:wrap.near"), undefined);
});

test("a correct signed quote binds pay_to to the recipient", () => {
  const r = verifyBinding(req(), quote(), opts);
  assert.deepEqual(r, { ok: true, problems: [] });
});

test("real 1Click key rejects a quote signed by anyone else", () => {
  const r = verifyBinding(req(), quote(), { ...opts, managerPublicKey: undefined });
  assert.ok(r.problems.includes("quote signature is not 1Click's"));
});

test("tampering with any signed field breaks the signature", () => {
  const q = quote();
  (q.quoteRequest as { recipient: string }).recipient = "0x" + "e".repeat(40);
  assert.ok(verifyBinding(req({ recipient: `base:0x${"e".repeat(40)}` }), q, opts).problems.includes("quote signature is not 1Click's"));
});

const cases: [string, Partial<SpendRequest>, Parameters<typeof quote>[0], RegExp][] = [
  ["agent swaps in another deposit address", { pay_to: "a".repeat(64) }, {}, /deposit address/],
  ["quote delivers to someone else", {}, { req: { recipient: "0x" + "b".repeat(40) } }, /requested recipient/],
  ["quote delivers on another chain", {}, { req: { destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" } }, /not on base/],
  ["refunds go to the attacker", {}, { req: { refundTo: "attacker.near" } }, /refunds/],
  ["amount differs", { amount: "2000000000000000000000000" }, {}, /exactly the requested amount/],
  ["dry quote has no deposit address", {}, { req: { dry: true }, quote: { depositAddress: undefined } }, /dry run/],
  ["deposit memo required", {}, { quote: { depositMemo: "123" } }, /memo/],
  ["expired quote", {}, { req: { deadline: "2026-11-05T12:00:30.000Z" }, quote: { deadline: "2026-11-05T12:00:30.000Z" } }, /deadline/],
  ["hidden fee skims value", {}, { quote: { amountOutUsd: "2.20" } }, /loses more than 3.0%/],
  ["native NEAR origin", { token: "near" }, {}, /native NEAR/],
  ["custom recipient message", {}, { req: { customRecipientMsg: "steal" } }, /redirects delivery/],
];

for (const [name, r, q, expect] of cases) {
  test(`binding rejects: ${name}`, () => {
    const res = verifyBinding(req(r), quote(q), opts);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => expect.test(p)), res.problems.join(" | "));
  });
}

const deps = (over: Partial<OracleDeps> = {}): OracleDeps => ({
  signer: new OracleSigner(new Uint8Array(32).fill(7)),
  rules: { denylist: new Set(), knownRecipients: [], denyAt: 70, reviewAt: 35 },
  ttlSecs: 120,
  now: () => NOW,
  verifyBinding: intentsBinder({ getVaultOwner: async () => "owner.near", managerPublicKey: MANAGER, verdictTtlSecs: 120 }),
  ...over,
});
const input = (over: Record<string, unknown> = {}) => ({ contract_id: "guard.testnet", vault_id: 0, request: req(), ...over });

test("oracle: cross-chain with a valid quote is allowed", async () => {
  const d = await decide(input({ intents_quote: quote() }), deps());
  assert.equal(d.verdict, "allow", JSON.stringify(d.signals));
});

test("oracle: cross-chain without a quote goes to review", async () => {
  const d = await decide(input(), deps());
  assert.equal(d.verdict, "review");
  assert.ok(d.signals.some((s) => s.id === "cross_chain_binding_unverified"));
});

test("oracle: a mismatching quote is denied", async () => {
  const q = quote({ req: { refundTo: "attacker.near" } });
  const d = await decide(input({ intents_quote: q }), deps());
  assert.equal(d.verdict, "deny");
  assert.ok(d.signals.some((s) => s.id === "cross_chain_binding_mismatch"));
});

test("oracle: if the owner lookup fails, a human decides", async () => {
  const q = quote();
  const failing = deps({ verifyBinding: async () => { throw new Error("rpc down"); } });
  const d = await decide(input({ intents_quote: q }), failing);
  assert.equal(d.verdict, "review");
});
