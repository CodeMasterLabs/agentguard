import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { decide, InputError, parseInput, type OracleDeps } from "./service.js";

const MAX_BODY = 32 * 1024;

export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new InputError("body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("body must be JSON");
  }
}

/**
 * POST /verdict  {contract_id, vault_id, request, context?} -> {verdict, expires_at, signature, score, signals}
 * GET  /pubkey   -> {public_key}   (pass to `set_oracle` on your vault)
 * GET  /health
 */
export function createOracleServer(deps: OracleDeps) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && req.url === "/pubkey") return send(res, 200, { public_key: deps.signer.publicKeyHex });
      if (req.method === "POST" && req.url === "/verdict") {
        const input = parseInput(await readJson(req));
        const d = await decide(input, deps);
        // Audit line. The context itself is not logged, only its hash.
        console.log(JSON.stringify({
          at: new Date().toISOString(), contract: input.contract_id, vault: input.vault_id, nonce: input.request.nonce,
          recipient: input.request.recipient, verdict: d.verdict, score: d.score, signals: d.signals.map((s) => s.id),
          context_sha256: createHash("sha256").update(input.context ?? "").digest("hex"),
        }));
        return send(res, 200, { ...d.attestation, score: d.score, signals: d.signals });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof InputError) return send(res, 400, { error: e.message });
      console.error(e);
      send(res, 500, { error: "internal error" });
    }
  });
}
