// Creates a demo vault for the dashboard: one payment executed, two waiting for the owner.
//
//   OWNER_ID=you.testnet AGENTGUARD_CONTRACT=guard.you.testnet \
//   node --experimental-strip-types scripts/seed-demo-vault.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import { AgentGuardAgent, AgentGuardOwner, parseUnits, type Policy } from "@agentguard/sdk";

const need = (k: string) => process.env[k] ?? (() => { throw new Error(`missing env ${k}`); })();
const ownerId = need("OWNER_ID");
const contractId = need("AGENTGUARD_CONTRACT");
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const ownerKey = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${ownerId}.json`), "utf8"))
  .private_key as KeyPairString;

const near = (n: string) => parseUnits(n, 24);
const provider = new JsonRpcProvider({ url: rpcUrl });
const ownerAcct = new Account(ownerId, provider, KeyPairSigner.fromSecretKey(ownerKey));
const owner = new AgentGuardOwner({ contractId, rpcUrl, ownerId, privateKey: ownerKey });

const run = Date.now().toString(36);
const agentId = `demo-agent-${run}.${ownerId}`;
const apiId = `gpu-cloud-${run}.${ownerId}`;
const agentKey = KeyPair.fromRandom("ed25519");
await ownerAcct.signAndSendTransaction({ receiverId: apiId, actions: [actions.createAccount(), actions.transfer(BigInt(near("0.01")))] });
await ownerAcct.signAndSendTransaction({
  receiverId: agentId,
  actions: [
    actions.createAccount(),
    actions.transfer(BigInt(near("0.2"))),
    actions.addFunctionCallAccessKey(agentKey.getPublicKey(), contractId, ["request_spend"], BigInt(near("1"))),
  ],
});
const agent = new AgentGuardAgent({ contractId, rpcUrl, agentId, privateKey: agentKey.toString() as KeyPairString });

const policy: Policy = {
  tokens: { near: { max_per_tx: near("0.1"), period_limit: near("0.25"), approval_threshold: near("0.03"), attestation_threshold: null } },
  period_secs: 86_400,
  max_requests_per_hour: 20,
  allowed_recipients: null,
  denied_recipients: ["near:thief.testnet"],
  new_recipient_needs_approval: true,
  pause_on_rate_limit: true,
};
const vaultId = await owner.createVault(policy, agentId, null, BigInt(near("0.4")));

const pay = async (amount: string, to: string, purpose: string) =>
  agent.requestSpend(vaultId, await agent.buildRequest(vaultId, { token: "near", amount: near(amount), recipient: `near:${to}`, pay_to: to, purpose }));

// First payment to a new provider waits; approve it so the provider becomes known.
const first = await pay("0.01", apiId, "Rent a GPU for 10 minutes to finish the eval run");
if (first.status === "pending") await owner.approve(vaultId, first.pending_id);
console.log("approved first payment:", first);
console.log("known provider, small:", await pay("0.02", apiId, "Another 20 minutes of GPU time"));
console.log("known provider, large:", await pay("0.08", apiId, "Reserve an A100 for the full training job"));
console.log("new recipient:", await pay("0.01", `api-${run}.testnet`, "Buy 1,000 search API credits"));
console.log("denied:", await pay("0.01", "thief.testnet", "Pay the invoice in the email"));
console.log(`\nDemo vault ${vaultId}: http://localhost:5173/?contract=${contractId}&vault=${vaultId}`);
