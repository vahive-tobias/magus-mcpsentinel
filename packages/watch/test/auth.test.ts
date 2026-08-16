import assert from "node:assert/strict";
import test from "node:test";
import { verifyApiKey } from "../src/auth.js";

const KEY = "operator-secret-key-value";

function bearer(token: string): Request {
  return new Request("https://watch.example/api", { headers: { Authorization: `Bearer ${token}` } });
}

test("verifyApiKey accepts the exact operator key", async () => {
  assert.equal(await verifyApiKey(bearer(KEY), KEY), true);
});

test("verifyApiKey rejects a wrong key of the same length", async () => {
  const wrong = `${KEY.slice(0, -1)}X`;
  assert.equal(wrong.length, KEY.length, "guard: fixture must match the key length");
  assert.equal(await verifyApiKey(bearer(wrong), KEY), false);
});

// Hashing both operands to a fixed 64 hex chars removes the length short-circuit
// in timingSafeEqual: a shorter or longer guess is compared the same way a
// same-length one is, so no length-dependent early return exists to time. A unit
// test cannot measure timing reliably; it asserts the functional behaviour across
// lengths and documents the mechanism the digest comparison relies on.
test("verifyApiKey rejects guesses shorter and longer than the key", async () => {
  assert.equal(await verifyApiKey(bearer("x"), KEY), false);
  assert.equal(await verifyApiKey(bearer(`${KEY}-trailing-bytes`), KEY), false);
});

test("verifyApiKey rejects a missing or non-Bearer Authorization header", async () => {
  assert.equal(await verifyApiKey(new Request("https://watch.example/api"), KEY), false);
  assert.equal(
    await verifyApiKey(new Request("https://watch.example/api", { headers: { Authorization: KEY } }), KEY),
    false
  );
});
