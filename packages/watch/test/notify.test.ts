import assert from "node:assert/strict";
import test from "node:test";
import { deliverNotice, deliveryConfigured } from "../src/notify.js";
import type { ChangeNoticeRecord, Env, WatchTargetRecord } from "../src/types.js";

/**
 * The change notice is the product. What these protect is not that an email is
 * pretty, but that an undelivered one is never mistaken for a delivered one, and
 * that the notice states evidence rather than a verdict.
 */

const TARGET: WatchTargetRecord = {
  id: "t1",
  account_id: "a1",
  package_name: "@scope/example-mcp",
  package_spec: "latest",
  enabled: 1,
  baseline_report_id: "b1",
  last_seen_version: "2.0.0",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z"
};

function notice(severity: "info" | "review" | "high", changes: unknown[]): ChangeNoticeRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    target_id: "t1",
    baseline_report_id: "b1",
    candidate_report_id: "c1",
    severity,
    summary: "summary",
    changes_json: JSON.stringify(changes),
    state: "pending_review",
    detected_at: "2026-08-08T00:00:00.000Z",
    decided_at: null,
    delivery_state: "pending",
    delivery_attempts: 0,
    delivered_at: null,
    delivery_detail: null
  };
}

const CHANGES = [
  { kind: "install_script_changed", severity: "high", summary: "Added install script: node setup.js" },
  { kind: "tool_description_changed", severity: "review", summary: "Tool read_file description changed." }
];

function configuredEnv(): Env {
  return { RESEND_API_KEY: "re_test", NOTIFY_FROM: "watch@example.test", NOTIFY_TO: "owner@example.test" } as unknown as Env;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const VERSIONS = { baseline: "1.4.0", candidate: "2.0.0" };

test("an unconfigured channel is reported, not silently skipped", async () => {
  assert.equal(deliveryConfigured({} as Env), false);
  assert.equal(deliveryConfigured({ RESEND_API_KEY: "x", NOTIFY_FROM: "a@b.test" } as unknown as Env), false, "a partial configuration is not configured");

  const outcome = await deliverNotice({} as Env, TARGET, notice("high", CHANGES), VERSIONS);
  assert.equal(outcome.state, "not_configured");
  assert.match(outcome.detail, /RESEND_API_KEY/);
});

test("a delivered notice carries the evidence, and no verdict", async () => {
  let sent: Record<string, unknown> = {};
  const restore = stubFetch((url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.method, "POST");
    assert.match(String((init.headers as Record<string, string>).authorization), /^Bearer re_test$/);
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  });

  const outcome = await deliverNotice(configuredEnv(), TARGET, notice("high", CHANGES), VERSIONS);
  restore();

  assert.equal(outcome.state, "sent");
  assert.deepEqual(sent.to, ["owner@example.test"]);
  assert.match(String(sent.subject), /@scope\/example-mcp@2\.0\.0/);

  for (const body of [String(sent.text), String(sent.html)]) {
    assert.match(body, /1\.4\.0/, "states the approved baseline it compared against");
    assert.match(body, /2\.0\.0/);
    assert.match(body, /install_script_changed/);
    assert.match(body, /Tool read_file description changed/);
    assert.doesNotMatch(body, /\b(malicious|unsafe|dangerous|compromised)\b/i, "a notice reports evidence, never a verdict");
  }
  assert.match(String(sent.text), /can be incomplete/, "states that the tool inventory may be partial");
});

/**
 * The stored summary is the only place the monitor can say something the diff
 * cannot know — how many other releases were published between these versions.
 *
 * Both renderers rebuilt a change count from `changes.length` instead, so anything
 * appended to the summary reached the database and stopped there. Found from a real
 * notice: firecrawl-mcp 3.23.6 to 3.23.8, with 3.23.7 published in between and no
 * mention of it in the email.
 */
test("the notice's own summary reaches the reader", async () => {
  let sent: Record<string, unknown> = {};
  const restore = stubFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  });

  const record = notice("review", CHANGES);
  record.summary = "@scope/example-mcp@2.0.0 has 2 reviewable changes from 1.4.0."
    + " 1 other release was published between these two versions.";
  await deliverNotice(configuredEnv(), TARGET, record, VERSIONS);
  restore();

  for (const body of [String(sent.text), String(sent.html)]) {
    assert.match(body, /1 other release was published between these two versions\./);
  }
});

test("a provider rejection is recorded as failed, with the provider's reason", async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({ message: "domain is not verified" }), { status: 403 }));
  const outcome = await deliverNotice(configuredEnv(), TARGET, notice("review", CHANGES), VERSIONS);
  restore();

  assert.equal(outcome.state, "failed");
  assert.match(outcome.detail, /403/);
  assert.match(outcome.detail, /domain is not verified/, "the provider's own message is what makes this fixable");
});

test("a network failure is a failed delivery, not a thrown error", async () => {
  const restore = stubFetch(() => { throw new Error("connection reset"); });
  const outcome = await deliverNotice(configuredEnv(), TARGET, notice("review", CHANGES), VERSIONS);
  restore();

  assert.equal(outcome.state, "failed", "a send that throws must still be recorded rather than losing the notice");
  assert.match(outcome.detail, /connection reset/);
});

// A package name or change summary is third-party text and reaches an HTML email.
test("package text cannot inject markup into the email", async () => {
  let sent: Record<string, unknown> = {};
  const restore = stubFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response("{}", { status: 200 });
  });

  const hostile = { ...TARGET, package_name: "<script>alert(1)</script>" };
  await deliverNotice(configuredEnv(), hostile, notice("high", [
    { kind: "tool_added", severity: "high", summary: "<img src=x onerror=alert(1)>" }
  ]), VERSIONS);
  restore();

  const html = String(sent.html);
  assert.doesNotMatch(html, /<script>/, "package text must be escaped");
  assert.doesNotMatch(html, /<img src=x/, "change text must be escaped");
  assert.match(html, /&lt;script&gt;/);
});
