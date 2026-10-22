// Runs the TEE oracle (tee-oracle/, an OutLayer project) and returns its signed output.
//
// Two transports, same component and same signing key per caller account:
//   - on-chain: request_execution on outlayer.{testnet,near}, paid in NEAR. The input is in
//     the transaction, so it is public on-chain, context included.
//   - HTTPS:   api.outlayer.ai/call/..., paid from a Payment Key. Only hashes of the input
//     and output are stored; use this when the context is sensitive.
import { Account, JsonRpcProvider, KeyPairSigner, actions, type KeyPairString } from "near-api-js";

export interface OutLayerConfig {
  /** `owner/name` of the deployed tee-oracle project. */
  projectId: string;
  network: "testnet" | "mainnet";
  /** Pin a version (its wasm sha256); null runs the active version. */
  versionKey?: string | null;
  /** HTTPS transport. */
  paymentKey?: string;
  /** On-chain transport: the account that calls OutLayer. Its account is the key's caller. */
  operatorId?: string;
  operatorKey?: KeyPairString;
  rpcUrl?: string;
}

export interface TeeRun {
  output: Record<string, unknown>;
  /** Where to fetch this run's TDX attestation. */
  attestation: string;
}

const TGAS = 10n ** 12n;
const LIMITS = { max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 30 };

export class OutLayerClient {
  private readonly account?: Account;
  private readonly provider?: JsonRpcProvider;

  constructor(private readonly cfg: OutLayerConfig) {
    if (!cfg.paymentKey) {
      if (!cfg.operatorId || !cfg.operatorKey) throw new Error("set a payment key, or an operator account and key");
      this.provider = new JsonRpcProvider({ url: cfg.rpcUrl ?? "https://rpc.testnet.fastnear.com" });
      this.account = new Account(cfg.operatorId, this.provider, KeyPairSigner.fromSecretKey(cfg.operatorKey));
    }
  }

  private get apiBase() {
    return this.cfg.network === "mainnet" ? "https://api.outlayer.ai" : "https://testnet-api.outlayer.ai";
  }

  run(input: Record<string, unknown>): Promise<TeeRun> {
    return this.cfg.paymentKey ? this.runHttps(input) : this.runOnChain(input);
  }

  private async runHttps(input: Record<string, unknown>): Promise<TeeRun> {
    const res = await fetch(`${this.apiBase}/call/${this.cfg.projectId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment-key": this.cfg.paymentKey! },
      body: JSON.stringify({ input, resource_limits: LIMITS, ...(this.cfg.versionKey ? { version_key: this.cfg.versionKey } : {}) }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json()) as { status: string; output?: unknown; error?: string; attestation_url?: string };
    if (!res.ok || body.status !== "completed") throw new Error(`OutLayer call failed: ${body.error ?? res.status}`);
    const output = typeof body.output === "string" ? JSON.parse(body.output) : body.output;
    return { output: output as Record<string, unknown>, attestation: `${this.apiBase}${body.attestation_url}` };
  }

  private async runOnChain(input: Record<string, unknown>): Promise<TeeRun> {
    const contract = this.cfg.network === "mainnet" ? "outlayer.near" : "outlayer.testnet";
    const sent = await this.account!.signAndSendTransaction({
      receiverId: contract,
      actions: [
        actions.functionCall(
          "request_execution",
          {
            source: { Project: { project_id: this.cfg.projectId, version_key: this.cfg.versionKey ?? null } },
            input_data: JSON.stringify(input),
            resource_limits: LIMITS,
            response_format: "Json",
          },
          300n * TGAS,
          5n * 10n ** 22n, // 0.05 NEAR cap; unused compute is refunded
        ),
      ],
      // The run resolves through yield/resume; waiting for full execution over RPC times out.
      waitUntil: "INCLUDED",
    });
    const txHash = sent.transaction.hash as string;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await this.provider!
        .viewTransactionStatusWithReceipts({ txHash, accountId: this.cfg.operatorId!, waitUntil: "EXECUTED_OPTIMISTIC" })
        .catch(() => undefined);
      const status = st?.status as { SuccessValue?: string; Failure?: unknown } | undefined;
      if (!status || (status.SuccessValue === undefined && !status.Failure)) continue;
      const logs = (st!.receipts_outcome ?? []).flatMap((r) => r.outcome.logs);
      const value = status.SuccessValue ? Buffer.from(status.SuccessValue, "base64").toString() : "";
      const output = value ? JSON.parse(value) : null;
      if (!output || typeof output !== "object") {
        const why = logs.find((l) => /fail|error|refund/i.test(l)) ?? JSON.stringify(status.Failure ?? value);
        throw new Error(`OutLayer run failed (tx ${txHash}): ${why}`);
      }
      // response_format Json may hand back the module's stdout parsed, or a {result} wrapper.
      const result = "result" in output && typeof output.result === "object" ? output.result : output;
      return { output: result as Record<string, unknown>, attestation: `${this.apiBase}/attestations/by-tx/${txHash}` };
    }
    throw new Error(`OutLayer run did not finish (tx ${txHash})`);
  }
}
