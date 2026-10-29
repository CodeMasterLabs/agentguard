#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createOracleServer } from "./server.js";
import { OracleSigner } from "./signer.js";
import type { OracleDeps } from "./service.js";
import { intentsBinder } from "./intents.js";
import { AgentGuardViewer } from "@agentguard/sdk";

const env = process.env;
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const fileList = (path?: string) => (path ? list(readFileSync(path, "utf8").replace(/\r?\n/g, ",")) : []);
// Fail at startup, not on every request: a NaN TTL would make each verdict throw.
const num = (name: string, fallback: number) => {
  const v = Number(env[name] ?? fallback);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number, got ${env[name]}`);
  return v;
};

// In a TEE, leave ORACLE_SEED_HEX unset: a fresh key is generated inside the enclave and
// only its public half leaves it (GET /pubkey). Set it only for local development.
const signer = env.ORACLE_SEED_HEX ? OracleSigner.fromHex(env.ORACLE_SEED_HEX) : OracleSigner.random();

const ttlSecs = num("ORACLE_TTL_SECS", 120);
const rpcUrl = env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";

const deps: OracleDeps = {
  signer,
  ttlSecs,
  verifyBinding: intentsBinder({
    async getVaultOwner(contractId, vaultId) {
      const vault = await new AgentGuardViewer({ contractId, rpcUrl }).getVault(vaultId);
      if (!vault) throw new Error(`vault ${vaultId} not found on ${contractId}`);
      return vault.owner;
    },
    // Test deployments only: 1Click's real key is the SDK default.
    managerPublicKey: env.ONECLICK_MANAGER_PUBKEY || undefined,
    maxValueLossBps: num("ORACLE_MAX_SWAP_LOSS_BPS", 300),
    verdictTtlSecs: ttlSecs,
  }),
  allowedContracts: env.ORACLE_ALLOWED_CONTRACTS ? new Set(list(env.ORACLE_ALLOWED_CONTRACTS)) : undefined,
  rules: {
    denylist: new Set([...list(env.ORACLE_DENYLIST), ...fileList(env.ORACLE_DENYLIST_FILE)].map((s) => s.toLowerCase())),
    knownRecipients: list(env.ORACLE_KNOWN_RECIPIENTS),
    denyAt: num("ORACLE_DENY_AT", 70),
    reviewAt: num("ORACLE_REVIEW_AT", 35),
  },
  llm:
    env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL
      ? { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL }
      : undefined,
};

const port = num("PORT", 8787);
createOracleServer(deps).listen(port, () => {
  console.log(`agentguard oracle on :${port}, public key ${signer.publicKeyHex}${deps.llm ? `, llm ${deps.llm.model}` : ""}`);
});
