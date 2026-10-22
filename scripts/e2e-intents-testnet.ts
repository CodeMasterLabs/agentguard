// Cross-chain (NEAR Intents) path on testnet. 1Click runs on mainnet only, so the quotes
// here are signed by a TEST manager key that this run's oracle is told to trust. Everything
// else is real: wrap.testnet, NEP-145 registration of a fresh deposit address, the token
// transfer, the oracle's binding checks and the contract's attestation check.
//
//   OWNER_ID=you.testnet AGENTGUARD_CONTRACT=guard.you.testnet \
//   node --experimental-strip-types scripts/e2e-intents-testnet.ts
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { base58 } from "@scure/base";
import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import { AgentGuardAgent, AgentGuardOwner, AgentGuardViewer, parseUnits, type Attestation, type Policy, type SpendRequest } from "@agentguard/sdk";
import { createOracleServer } from "../oracle/dist/server.js";
import { OracleSigner } from "../oracle/dist/signer.js";
import { intentsBinder, type IntentsQuote } from "../oracle/dist/intents.js";

const need = (k: string) => process.env[k] ?? (() => { throw new Error(`missing env ${k}`); })();
const ownerId = need("OWNER_ID");
const contractId = need("AGENTGUARD_CONTRACT");
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const WNEAR = "wrap.testnet";
const ownerKey = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${ownerId}.json`), "utf8"))
  .private_key as KeyPairString;

const near = (n: string) => parseUnits(n, 24);
const TGAS = 10n ** 12n;
const provider = new JsonRpcProvider({ url: rpcUrl });
const ownerAcct = new Account(ownerId, provider, KeyPairSigner.fromSecretKey(ownerKey));
const owner = new AgentGuardOwner({ contractId, rpcUrl, ownerId, privateKey: ownerKey });
let failures = 0;
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
const ftBalance = async (id: string) =>
  BigInt((await provider.callFunction({ contractId: WNEAR, method: "ft_balance_of", args: { account_id: id } })) as string);
const call = (contract: string, methodName: string, args: object, deposit: bigint, gas = 50n * TGAS) =>
  ownerAcct.callFunction({ contractId: contract, methodName, args, deposit, gas });

// ---- TEST 1Click manager key (never the real one) ----
const managerPriv = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), randomBytes(32)]),
  format: "der",
  type: "pkcs8",
});
const spki = createPublicKey(managerPriv).export({ format: "der", type: "spki" });
const TEST_MANAGER = `ed25519:${base58.encode(spki.subarray(spki.length - 32))}`;

function signedQuote(p: { depositAddress: string; recipient: string; amount: string; refundTo: string }): IntentsQuote {
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const q = {
    correlationId: "agentguard-e2e",
    timestamp: new Date().toISOString(),
    signature: "",
    quoteRequest: {
      dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: `nep141:${WNEAR}`,
      depositType: "ORIGIN_CHAIN", destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      amount: p.amount, refundTo: p.refundTo, refundType: "ORIGIN_CHAIN", recipient: p.recipient,
      recipientType: "DESTINATION_CHAIN", deadline,
    },
    quote: {
      depositAddress: p.depositAddress, amountIn: p.amount, amountInFormatted: "0.01", amountInUsd: "0.025",
      minAmountIn: p.amount, amountOut: "24700", amountOutFormatted: "0.0247", amountOutUsd: "0.0247",
      minAmountOut: "24400", deadline, timeEstimate: 30,
    },
  } as unknown as IntentsQuote;
  const sig = sign(null, new TextEncoder().encode(quoteHash(q)), managerPriv);
  return { ...q, signature: `ed25519:${base58.encode(sig)}` };
}

// ---- wNEAR for the owner, registration for the contract ----
await call(WNEAR, "storage_deposit", { account_id: ownerId, registration_only: true }, BigInt(near("0.00125")));
await call(WNEAR, "storage_deposit", { account_id: contractId, registration_only: true }, BigInt(near("0.00125")));
await call(WNEAR, "near_deposit", {}, BigInt(near("0.05")));

// ---- agent ----
const run = Date.now().toString(36);
const agentId = `xagent-${run}.${ownerId}`;
const agentKey = KeyPair.fromRandom("ed25519");
await ownerAcct.signAndSendTransaction({
  receiverId: agentId,
  actions: [
    actions.createAccount(),
    actions.transfer(BigInt(near("0.5"))),
    actions.addFunctionCallAccessKey(agentKey.getPublicKey(), contractId, ["request_spend"], BigInt(near("1"))),
  ],
});
const agent = new AgentGuardAgent({ contractId, rpcUrl, agentId, privateKey: agentKey.toString() as KeyPairString });

// ---- oracle that trusts the TEST manager key ----
const signer = OracleSigner.random();
const viewer = new AgentGuardViewer({ contractId, rpcUrl });
const oracle = createOracleServer({
  signer,
  ttlSecs: 120,
  allowedContracts: new Set([contractId]),
  rules: { denylist: new Set(), knownRecipients: [], denyAt: 70, reviewAt: 35 },
  verifyBinding: intentsBinder({
    getVaultOwner: async (c, v) => (await viewer.getVault(v))!.owner,
    managerPublicKey: TEST_MANAGER,
    verdictTtlSecs: 120,
  }),
});
await new Promise<void>((r) => oracle.listen(0, "127.0.0.1", r));
const oracleUrl = `http://127.0.0.1:${(oracle.address() as AddressInfo).port}`;

// ---- vault holding wNEAR, plus a little NEAR for deposit-address registration ----
const policy: Policy = {
  tokens: {
    near: { max_per_tx: near("0.01"), period_limit: near("0.02"), approval_threshold: near("0.01"), attestation_threshold: null },
    [WNEAR]: { max_per_tx: near("0.02"), period_limit: near("0.05"), approval_threshold: near("0.02"), attestation_threshold: null },
  },
  period_secs: 86_400,
  max_requests_per_hour: 20,
  allowed_recipients: null,
  denied_recipients: [],
  new_recipient_needs_approval: false,
  pause_on_rate_limit: true,
};
const vaultId = await owner.createVault(policy, agentId, signer.publicKeyHex, BigInt(near("0.12")));
await call(WNEAR, "ft_transfer_call", { receiver_id: contractId, amount: near("0.04"), msg: String(vaultId) }, 1n, 100n * TGAS);
const v0 = (await owner.getVault(vaultId))!;
check("vault funded with wNEAR via ft_transfer_call", v0.balances[WNEAR] === near("0.04"), `${v0.balances[WNEAR]} wNEAR, ${v0.balances.near} NEAR`);

const RECIPIENT = "0x" + randomBytes(20).toString("hex");
const freshDeposit = () => randomBytes(32).toString("hex");

async function payCrossChain(payTo: string, quote?: IntentsQuote) {
  const request: SpendRequest = await agent.buildRequest(vaultId, {
    token: WNEAR, amount: near("0.01"), recipient: `base:${RECIPIENT}`, pay_to: payTo, purpose: "Pay the GPU provider on Base",
  });
  const res = await fetch(`${oracleUrl}/verdict`, {
    method: "POST",
    body: JSON.stringify({ contract_id: contractId, vault_id: vaultId, request, context: "", intents_quote: quote }),
  });
  const verdict = (await res.json()) as Attestation & { signals: { id: string; detail?: string }[] };
  return { result: await agent.requestSpend(vaultId, request, verdict), verdict };
}

try {
  // 1. Valid signed quote: pays the fresh deposit address, registering it first.
  const deposit = freshDeposit();
  const before = (await owner.getVault(vaultId))!;
  let { result, verdict } = await payCrossChain(deposit, signedQuote({ depositAddress: deposit, recipient: RECIPIENT, amount: near("0.01"), refundTo: ownerId }));
  check("valid 1Click quote: oracle allows", verdict.verdict === "allow", verdict.signals.map((s) => s.id));
  check("valid 1Click quote: contract executes", result.status === "executed", result);
  await new Promise((r) => setTimeout(r, 3000));
  check("deposit address received the wNEAR", (await ftBalance(deposit)) === BigInt(near("0.01")), `${await ftBalance(deposit)}`);
  const after = (await owner.getVault(vaultId))!;
  check(
    "registration fee (0.00125 NEAR) came from the vault",
    BigInt(before.balances.near) - BigInt(after.balances.near) === BigInt(near("0.00125")),
    `${before.balances.near} -> ${after.balances.near}`,
  );

  // 2. Agent asks a quote with refunds to itself.
  const d2 = freshDeposit();
  ({ result, verdict } = await payCrossChain(d2, signedQuote({ depositAddress: d2, recipient: RECIPIENT, amount: near("0.01"), refundTo: agentId })));
  check("refunds to the agent: denied", result.status === "denied" && result.reason === "oracle_denied", verdict.signals.map((s) => s.detail ?? s.id));

  // 3. Valid quote, but the agent pays a different address than the quote's.
  const d3 = freshDeposit();
  ({ result } = await payCrossChain(freshDeposit(), signedQuote({ depositAddress: d3, recipient: RECIPIENT, amount: near("0.01"), refundTo: ownerId })));
  check("pay_to swapped after quoting: denied", result.status === "denied" && result.reason === "oracle_denied", result);

  // 4. No quote at all: a human decides.
  ({ result } = await payCrossChain(freshDeposit()));
  check("no quote: held for the owner", result.status === "pending" && result.reason === "oracle_review", result);
  if (result.status === "pending") await owner.reject(vaultId, result.pending_id);

  // Return everything to the owner.
  const end = (await owner.getVault(vaultId))!;
  await owner.withdraw(vaultId, WNEAR, end.balances[WNEAR]);
  await owner.withdraw(vaultId, "near", end.balances.near);
  const drained = (await owner.getVault(vaultId))!;
  check("owner withdrew wNEAR and NEAR", drained.balances[WNEAR] === "0" && drained.balances.near === "0", "both 0");
} finally {
  oracle.close();
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  vault ${vaultId} on ${contractId}`);
process.exit(failures === 0 ? 0 : 1);
