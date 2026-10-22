import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { NATIVE, type Attestation, type PendingSpend, type Policy, type SpendRequest, type SpendResult, type Vault } from "./types.js";

const TGAS = 1_000_000_000_000n;
const ONE_YOCTO = 1n;

export interface ClientOptions {
  /** AgentGuard contract account, e.g. `agentguard.testnet`. */
  contractId: string;
  /** JSON-RPC endpoint. Defaults to the public testnet RPC. */
  rpcUrl?: string;
}

/** Read-only access. Anyone can use this, no keys needed. */
export class AgentGuardViewer {
  readonly contractId: string;
  readonly provider: JsonRpcProvider;

  constructor({ contractId, rpcUrl = "https://rpc.testnet.fastnear.com" }: ClientOptions) {
    this.contractId = contractId;
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  // Optimistic, not final: a vault or nonce written by a transaction that just executed
  // is visible right away instead of a couple of blocks later.
  protected view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.provider.callFunction({ contractId: this.contractId, method, args, blockQuery: { finality: "optimistic" } }) as Promise<T>;
  }

  getVault(vaultId: number) {
    return this.view<Vault | null>("get_vault", { vault_id: vaultId });
  }
  getNonce(vaultId: number) {
    return this.view<number>("get_nonce", { vault_id: vaultId });
  }
  getPending(vaultId: number) {
    return this.view<PendingSpend[]>("get_pending", { vault_id: vaultId });
  }
  getVaultsOf(owner: string) {
    return this.view<number[]>("get_vaults_of", { owner });
  }
  /** 24 for NEAR, otherwise read from the token's NEP-148 metadata. */
  async tokenDecimals(token: string): Promise<number> {
    if (token === NATIVE) return 24;
    const meta = (await this.provider.callFunction({ contractId: token, method: "ft_metadata", args: {} })) as {
      decimals: number;
    };
    return meta.decimals;
  }
  attestationMessage(vaultId: number, request: SpendRequest, verdict: Attestation["verdict"], expiresAt: string) {
    return this.view<string>("attestation_message", { vault_id: vaultId, request, verdict, expires_at: expiresAt });
  }
}

/**
 * What an AI agent uses. The agent's key should be a function-call key limited to
 * `request_spend` on the AgentGuard contract (see scripts/provision-agent.ts).
 */
export class AgentGuardAgent extends AgentGuardViewer {
  readonly account: Account;

  constructor(opts: ClientOptions & { agentId: string; privateKey: KeyPairString }) {
    super(opts);
    this.account = new Account(opts.agentId, this.provider, KeyPairSigner.fromSecretKey(opts.privateKey));
  }

  /** Fill in the current nonce if not given. */
  async buildRequest(vaultId: number, r: Omit<SpendRequest, "nonce"> & { nonce?: number }): Promise<SpendRequest> {
    return { ...r, nonce: r.nonce ?? (await this.getNonce(vaultId)) };
  }

  requestSpend(vaultId: number, request: SpendRequest, attestation?: Attestation): Promise<SpendResult> {
    return this.account.callFunction({
      contractId: this.contractId,
      methodName: "request_spend",
      args: { vault_id: vaultId, request, attestation: attestation ?? null },
      // Checks, then up to three promises (storage_deposit, ft_transfer, settle). Kept modest because
      // prepaid gas is reserved from the agent's balance (and key allowance) at a pessimistic price.
      gas: 80n * TGAS,
    }) as Promise<SpendResult>;
  }
}

/** What the owner (or a script acting for them with a full-access key) uses. */
export class AgentGuardOwner extends AgentGuardViewer {
  readonly account: Account;

  constructor(opts: ClientOptions & { ownerId: string; privateKey: KeyPairString }) {
    super(opts);
    this.account = new Account(opts.ownerId, this.provider, KeyPairSigner.fromSecretKey(opts.privateKey));
  }

  private call<T>(methodName: string, args: Record<string, unknown>, deposit: bigint = ONE_YOCTO, gas = 100n * TGAS) {
    return this.account.callFunction({ contractId: this.contractId, methodName, args, deposit, gas }) as Promise<T>;
  }

  /** `depositYocto` must include the 0.1 NEAR storage fee; the rest funds the vault. */
  createVault(policy: Policy, agent: string | null, oraclePk: string | null, depositYocto: bigint) {
    return this.call<number>("create_vault", { policy, agent, oracle_pk: oraclePk }, depositYocto);
  }
  updatePolicy(vaultId: number, policy: Policy) {
    return this.call<void>("update_policy", { vault_id: vaultId, policy });
  }
  setAgent(vaultId: number, agent: string | null) {
    return this.call<void>("set_agent", { vault_id: vaultId, agent });
  }
  setOracle(vaultId: number, oraclePk: string | null) {
    return this.call<void>("set_oracle", { vault_id: vaultId, oracle_pk: oraclePk });
  }
  pause(vaultId: number) {
    return this.call<void>("pause", { vault_id: vaultId }, 0n);
  }
  unpause(vaultId: number) {
    return this.call<void>("unpause", { vault_id: vaultId });
  }
  approve(vaultId: number, pendingId: number) {
    return this.call<boolean>("approve_pending", { vault_id: vaultId, pending_id: pendingId });
  }
  reject(vaultId: number, pendingId: number) {
    return this.call<void>("reject_pending", { vault_id: vaultId, pending_id: pendingId });
  }
  depositNear(vaultId: number, yocto: bigint) {
    return this.call<void>("deposit_near", { vault_id: vaultId }, yocto);
  }
  withdraw(vaultId: number, token: string, amount: string, to?: string) {
    return this.call<void>("withdraw", { vault_id: vaultId, token, amount, to: to ?? null });
  }
}
