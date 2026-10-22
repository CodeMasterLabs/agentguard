#!/usr/bin/env node
// Gateway to the TEE oracle: the same HTTP API as the local oracle (POST /verdict,
// GET /pubkey), but every decision is made and signed inside OutLayer's TEE.
//
// The gateway cannot forge a verdict: it never holds the signing key. It pays for runs
// and passes the request through, so the vault owner should run it with their own operator
// account (that account is the key's caller, see tee-oracle/manifest.json).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { InputError, parseInput } from "./service.js";
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

let pinned: { public_key: string; attestation: string } | undefined;
async function teeKey() {
  if (!pinned) {
    const run = await client.run({ op: "public_key" });
    if (typeof run.output.public_key !== "string") throw new Error(`TEE did not return a key: ${JSON.stringify(run.output)}`);
    pinned = { public_key: run.output.public_key, attestation: run.attestation };
  }
  return pinned;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 32 * 1024) throw new InputError("body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("body must be JSON");
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, tee: client ? network : null });
    if (req.method === "GET" && req.url === "/pubkey") return send(res, 200, await teeKey());
    if (req.method === "POST" && req.url === "/verdict") {
      const input = parseInput(await readJson(req));
      const run = await client.run({ op: "verdict", ...input, config });
      const out = run.output as { verdict?: string; error?: string; public_key?: string };
      if (out.error || !out.verdict) throw new Error(`TEE oracle: ${out.error ?? "no verdict"}`);
      const key = await teeKey();
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
}).listen(Number(env.PORT ?? 8788), () => console.log(`agentguard TEE gateway on :${env.PORT ?? 8788} -> ${network} OutLayer`));
