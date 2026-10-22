// ed25519 signing with Node's built-in crypto. The 32-byte seed is the oracle's identity;
// inside a TEE it is generated in the enclave and never leaves it.
import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";

// DER prefix that wraps a raw 32-byte ed25519 seed as PKCS#8.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class OracleSigner {
  private readonly key: KeyObject;
  /** Hex public key, the value the vault owner passes to `set_oracle`. */
  readonly publicKeyHex: string;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
    const spki = createPublicKey(this.key).export({ format: "der", type: "spki" });
    this.publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  }

  static fromHex(seedHex: string) {
    return new OracleSigner(Buffer.from(seedHex, "hex"));
  }

  static random() {
    return new OracleSigner(randomBytes(32));
  }

  /** Hex 64-byte signature over the UTF-8 message. */
  sign(message: string): string {
    return sign(null, Buffer.from(message, "utf8"), this.key).toString("hex");
  }
}
