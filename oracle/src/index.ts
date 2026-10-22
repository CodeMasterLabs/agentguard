#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createOracleServer } from "./server.js";
import { OracleSigner } from "./signer.js";
import type { OracleDeps } from "./service.js";

const env = process.env;
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const fileList = (path?: string) => (path ? list(readFileSync(path, "utf8").replace(/\r?\n/g, ",")) : []);

// In a TEE, leave ORACLE_SEED_HEX unset: a fresh key is generated inside the enclave and
// only its public half leaves it (GET /pubkey). Set it only for local development.
const signer = env.ORACLE_SEED_HEX ? OracleSigner.fromHex(env.ORACLE_SEED_HEX) : OracleSigner.random();

const deps: OracleDeps = {
  signer,
  ttlSecs: Number(env.ORACLE_TTL_SECS ?? 120),
  allowedContracts: env.ORACLE_ALLOWED_CONTRACTS ? new Set(list(env.ORACLE_ALLOWED_CONTRACTS)) : undefined,
  rules: {
    denylist: new Set([...list(env.ORACLE_DENYLIST), ...fileList(env.ORACLE_DENYLIST_FILE)].map((s) => s.toLowerCase())),
    knownRecipients: list(env.ORACLE_KNOWN_RECIPIENTS),
    denyAt: Number(env.ORACLE_DENY_AT ?? 70),
    reviewAt: Number(env.ORACLE_REVIEW_AT ?? 35),
  },
  llm:
    env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL
      ? { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL }
      : undefined,
};

const port = Number(env.PORT ?? 8787);
createOracleServer(deps).listen(port, () => {
  console.log(`agentguard oracle on :${port}, public key ${signer.publicKeyHex}${deps.llm ? `, llm ${deps.llm.model}` : ""}`);
});
