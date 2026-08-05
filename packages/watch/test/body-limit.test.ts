import assert from "node:assert/strict";
import test from "node:test";
import { BodyTooLargeError, readBoundedText } from "../src/worker.js";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://watch.test/api/reports", { method: "POST", body, headers });
}

test("reads a body that fits within the limit", async () => {
  const text = await readBoundedText(post('{"ok":true}'), 1024);
  assert.equal(text, '{"ok":true}');
});

test("reads a body of exactly the limit", async () => {
  const body = "x".repeat(64);
  assert.equal(await readBoundedText(post(body), 64), body);
});

// The report endpoint is reachable before any signature is verified, so an
// unauthenticated caller must not be able to choose how much the Worker buffers.
test("refuses a streamed body that exceeds the limit", async () => {
  await assert.rejects(() => readBoundedText(post("x".repeat(5000)), 1024), BodyTooLargeError);
});

test("refuses an oversized body before reading it when content-length declares the size", async () => {
  const request = new Request("https://watch.test/api/reports", {
    method: "POST",
    body: "x".repeat(10),
    headers: { "content-length": "999999999" }
  });
  await assert.rejects(() => readBoundedText(request, 1024), BodyTooLargeError);
});

// content-length is attacker-controlled, so a small declared size must not buy a
// caller the right to stream an unbounded body.
test("still enforces the limit when content-length understates the real size", async () => {
  const request = new Request("https://watch.test/api/reports", {
    method: "POST",
    body: "x".repeat(5000),
    headers: { "content-length": "10" }
  });
  await assert.rejects(() => readBoundedText(request, 1024), BodyTooLargeError);
});

test("decodes multi-byte UTF-8 split across the stream correctly", async () => {
  const text = "π é 漢字 🔐";
  assert.equal(await readBoundedText(post(text), 1024), text);
});

test("returns an empty string for a body-less request", async () => {
  const request = new Request("https://watch.test/health", { method: "GET" });
  assert.equal(await readBoundedText(request, 1024), "");
});
