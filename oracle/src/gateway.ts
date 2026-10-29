#!/usr/bin/env node
// Gateway to the TEE oracle: the same HTTP API as the local oracle (POST /verdict,
// GET /pubkey), but every decision is made and signed inside OutLayer's TEE.
//
// The gateway cannot forge a verdict: it never holds the signing key. It pays for runs
// and passes the request through, so the vault owner should run it with their own operator
// account (that account is the key's caller, see tee-oracle/manifest.json).
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { InputError, parseInput } from "./service.js";
import { readJson, send } from "./server.js";
import { OutLayerClient } from "./outlayer.js";
import type { KeyPairString } from "near-api-js";

const env = process.env;
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const keyFromFile = (path?: string) => (path ? (JSON.parse(readFileSync(path, "utf8")).private_key as KeyPairString) : undefined);

const network = env.OUTLAYER_NETWORK === "mainnet" ? "mainnet" : "testnet";
const client = new OutLayerClient({
  projectId: env.OUTLAYER_PROJECT ?? "cm-agentguard.testnet/agentguard-oracle",
  network,
  versionKey: env.OUTLAYER_VERSION || null,
  paymentKey: env.OUTLAYER_PAYMENT_KEY || undefined,
  operatorId: env.OUTLAYER_OPERATOR_ID,
  operatorKey: (env.OUTLAYER_OPERATOR_KEY as KeyPairString | undefined) ?? keyFromFile(env.OUTLAYER_OPERATOR_KEY_FILE),
  rpcUrl: env.NEAR_RPC_URL,
});

// Passed to the TEE with every request. The component clamps the TTL and ignores the
// 1Click key override outside testnet.
const config = {
  denylist: list(env.ORACLE_DENYLIST),
  known_recipients: list(env.ORACLE_KNOWN_RECIPIENTS),
  review_at: Number(env.ORACLE_REVIEW_AT ?? 35),
  deny_at: Number(env.ORACLE_DENY_AT ?? 70),
  max_swap_loss_bps: Number(env.ORACLE_MAX_SWAP_LOSS_BPS ?? 300),
  ttl_secs: Number(env.ORACLE_TTL_SECS ?? 120),
  ...(env.ONECLICK_MANAGER_PUBKEY ? { oneclick_manager_pubkey: env.ONECLICK_MANAGER_PUBKEY } : {}),
};

// The promise is cached, not its result, so concurrent first requests share one paid run.
// A failed lookup is forgotten so the next request retries.
let pinned: Promise<{ public_key: string; attestation: string }> | undefined;
function teeKey() {
  pinned ??= client.run({ op: "public_key" }).then((run) => {
    if (typeof run.output.public_key !== "string") throw new Error(`TEE did not return a key: ${JSON.stringify(run.output)}`);
    return { public_key: run.output.public_key, attestation: run.attestation };
  });
  pinned.catch(() => (pinned = undefined));
  return pinned;
}

// Every verdict is a paid TEE run, so the gateway listens on localhost unless told
// otherwise, and with GATEWAY_TOKEN set it also wants `authorization: Bearer <token>`.
const host = env.HOST ?? "127.0.0.1";
const token = env.GATEWAY_TOKEN ? Buffer.from(`Bearer ${env.GATEWAY_TOKEN}`) : undefined;
const authorized = (header?: string) => {
  if (!token) return true;
  const got = Buffer.from(header ?? "");
  return got.length === token.length && timingSafeEqual(got, token);
};

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, tee: network });
    if (!authorized(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/pubkey") return send(res, 200, await teeKey());
    if (req.method === "POST" && req.url === "/verdict") {
      const input = parseInput(await readJson(req));
      // Started alongside the verdict run, so a cold start does not wait for two runs in a row.
      const keyP = teeKey();
      const run = await client.run({ op: "verdict", ...input, config });
      const out = run.output as { verdict?: string; error?: string; public_key?: string };
      if (out.error || !out.verdict) throw new Error(`TEE oracle: ${out.error ?? "no verdict"}`);
      const key = await keyP;
      if (out.public_key !== key.public_key) throw new Error("TEE signed with an unexpected key");
      console.log(JSON.stringify({ at: new Date().toISOString(), vault: input.vault_id, nonce: input.request.nonce, verdict: out.verdict, attestation: run.attestation }));
      return send(res, 200, { ...out, attestation: run.attestation });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof InputError) return send(res, 400, { error: e.message });
    console.error(e);
    send(res, 502, { error: String(e instanceof Error ? e.message : e) });
  }
}).listen(Number(env.PORT ?? 8788), host, () => console.log(`agentguard TEE gateway on ${host}:${env.PORT ?? 8788} -> ${network} OutLayer`));
