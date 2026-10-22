// Create an agent account whose ONLY key is a function-call key for
// `request_spend` on the AgentGuard contract. The agent can ask to spend from its
// vault and pay gas from a small allowance, nothing else: no transfers, no new keys,
// no other contracts.
//
//   OWNER_ID=you.testnet OWNER_PRIVATE_KEY=ed25519:... AGENTGUARD_CONTRACT=agentguard.testnet \
//   node --experimental-strip-types scripts/provision-agent.ts agent1
//
// Writes the agent's key to .env.agent (gitignored). Never commit it.
import { writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, type KeyPairString } from "near-api-js";

const need = (k: string) => process.env[k] ?? (() => { throw new Error(`missing env ${k}`); })();
const ownerId = need("OWNER_ID");
const contractId = need("AGENTGUARD_CONTRACT");
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const prefix = process.argv[2] ?? "agent";
const agentId = `${prefix}.${ownerId}`;

const provider = new JsonRpcProvider({ url: rpcUrl });
const owner = new Account(ownerId, provider, KeyPairSigner.fromSecretKey(need("OWNER_PRIVATE_KEY") as KeyPairString));
const agentKey = KeyPair.fromRandom("ed25519");

await owner.signAndSendTransaction({
  receiverId: agentId,
  actions: [
    actions.createAccount(),
    // 0.5 NEAR: storage plus room for prepaid gas, which is reserved before refunds land.
    actions.transfer(5n * 10n ** 23n),
    actions.addFunctionCallAccessKey(agentKey.getPublicKey(), contractId, ["request_spend"], 10n ** 24n),
  ],
});

writeFileSync(
  ".env.agent",
  `AGENT_ACCOUNT_ID=${agentId}\nAGENT_PRIVATE_KEY=${agentKey.toString()}\nAGENTGUARD_CONTRACT=${contractId}\n`,
  { mode: 0o600 },
);
console.log(`Created ${agentId} with a request_spend-only key (1 NEAR gas allowance). Key saved to .env.agent`);
