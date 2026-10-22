import { test } from "node:test";
import assert from "node:assert/strict";
import { attestationMessage } from "../src/encoding.ts";
import { formatUnits, parseUnits } from "../src/units.ts";

// Same vector as GOLDEN_MESSAGE in contract/src/tests.rs.
const GOLDEN =
  "agentguard:v1|guard.testnet|0|cb6531a5f332dcfd6262d2cb2b8aa934b496522aa4370c2605da3c24556b1e55|allow|1700000001000000000";

test("attestation message matches the Rust contract", () => {
  const req = {
    token: "near",
    amount: "100000000000000000000000",
    recipient: "base:0x1111",
    pay_to: "a".repeat(64),
    purpose: "buy API credits | test",
    nonce: 3,
  };
  assert.equal(attestationMessage("guard.testnet", 0, req, "allow", "1700000001000000000"), GOLDEN);
});

test("units round-trip exactly", () => {
  assert.equal(parseUnits("2.5", 6), "2500000");
  assert.equal(parseUnits("0.1", 24), "100000000000000000000000");
  assert.equal(formatUnits("2500000", 6), "2.5");
  assert.equal(formatUnits("3000000", 6), "3");
  assert.throws(() => parseUnits("1.1234567", 6));
  assert.throws(() => parseUnits("-1", 6));
});
