// Must match contract/src/attestation.rs byte for byte. The contract exposes
// `attestation_message` as a view so this can be checked against a live deployment.
import { createHash } from "node:crypto";
import type { SpendRequest, Verdict } from "./types.js";

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function requestHash(req: SpendRequest): string {
  const canonical = [req.token, req.amount, req.recipient, req.pay_to, sha256Hex(req.purpose), req.nonce].join("|");
  return sha256Hex(canonical);
}

export function attestationMessage(
  contractId: string,
  vaultId: number,
  req: SpendRequest,
  verdict: Verdict,
  expiresAtNs: string,
): string {
  return ["agentguard:v1", contractId, vaultId, requestHash(req), verdict, expiresAtNs].join("|");
}
