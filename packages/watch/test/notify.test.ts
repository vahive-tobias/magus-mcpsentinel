import assert from "node:assert/strict";
import test from "node:test";
import { verifyNoticeLinkToken } from "../src/auth.js";
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

async function bodies(changes: unknown[]): Promise<string[]> {
  let sent: Record<string, unknown> = {};
  const restore = stubFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  });
  await deliverNotice(configuredEnv(), TARGET, notice("review", changes), VERSIONS);
  restore();
  return [String(sent.text), String(sent.html)];
}

/**
 * A notice that states a count while holding the names is the tool asking the
 * reader to come and ask. Found in a real notice: firecrawl-mcp reported "1 added,
 * 0 removed" for a release that added `dist/www-authenticate.js`, under a column
 * headed Detail, with the name sitting unrendered in the change it came from.
 */
test("a change names the files behind its count", async () => {
  for (const body of await bodies([
    {
      kind: "file_inventory_changed", severity: "info",
      summary: "File inventory changed: 1 added, 1 removed.",
      detail: { added: ["package/dist/www-authenticate.js"], removed: ["package/dist/legacy.js"] }
    },
    {
      kind: "file_content_changed", severity: "info",
      summary: "3 files changed contents without changing the inventory.",
      detail: { count: 3, paths: ["package/README.md", "package/dist/index.js", "package/package.json"], truncated: false }
    }
  ])) {
    assert.match(body, /www-authenticate\.js/, "the added file is named");
    assert.match(body, /legacy\.js/, "the removed file is named");
    assert.match(body, /package\/dist\/index\.js/, "an edited file is named");
    assert.doesNotMatch(body, /and \d+ more/, "nothing was omitted, so nothing claims to be");
  }
});

test("a capped list says how many it is not showing", async () => {
  const paths = Array.from({ length: 40 }, (_, index) => `package/src/file-${index}.js`);
  for (const body of await bodies([{
    kind: "file_content_changed", severity: "info",
    summary: "40 files changed contents without changing the inventory.",
    // What the analyzer names is already capped; `count` is the truth about how
    // many there were, and the notice must not imply the named ten are all of them.
    detail: { count: 40, paths: paths.slice(0, 10), truncated: true }
  }])) {
    assert.match(body, /file-0\.js/);
    assert.match(body, /file-9\.js/);
    assert.doesNotMatch(body, /file-10\.js/, "the display limit holds");
    assert.match(body, /and 30 more/, "the reader is told the list is partial");
  }
});

test("a change whose summary already names its items does not repeat them", async () => {
  for (const body of await bodies([{
    kind: "tool_schema_changed", severity: "high",
    summary: "Tool read_file accepts new input fields: encoding, follow_symlinks.",
    detail: { tool: "read_file", addedProperties: ["encoding", "follow_symlinks"] }
  }])) {
    assert.equal((body.match(/follow_symlinks/g) ?? []).length, 1, "named once, in the summary");
  }
});

test("a notice stored before details were carried still renders", async () => {
  // Every notice already in the database has changes with no `detail` at all.
  for (const body of await bodies([
    { kind: "artifact_changed", severity: "review", summary: "Artifact digest changed: aaaa… → bbbb…." }
  ])) {
    assert.match(body, /Artifact digest changed/);
    assert.doesNotMatch(body, /undefined/);
  }
});

/**
 * The reader sees the same three words here as on the public watch page.
 *
 * `info` was the reason for doing this: a machine word next to a package someone
 * is deciding whether to upgrade, which tells them nothing about what to do with
 * it. The stored values are untouched — the API still speaks high/review/info.
 */
test("severities are worded for a reader, in both bodies", async () => {
  for (const body of await bodies([
    { kind: 'install_script_changed', severity: 'high', summary: 'Added install script: node setup.js' },
    { kind: 'artifact_changed', severity: 'review', summary: 'Artifact digest changed: aaaa… → bbbb….' },
    { kind: 'file_content_changed', severity: 'info', summary: '2 files changed contents without changing the inventory.' }
  ])) {
    assert.match(body, /Worth reading/);
    assert.match(body, /Review/);
    assert.match(body, /Context/);
    // The severity column must not still be printing the raw value beside them.
    assert.doesNotMatch(body, /\[info\]/);
    assert.doesNotMatch(body, />info</);
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

/**
 * The capability link, and the two ways it must not appear.
 *
 * The link is what turns a notice from a report into something the reader can
 * act on without an account. It is also a credential in someone's inbox, so an
 * unsigned or unroutable one is worse than none — the reader clicks it, gets a
 * 404, and learns the product does not work.
 */
async function bodiesFrom(extra: Partial<Env>): Promise<string[]> {
  let sent: Record<string, unknown> = {};
  const restore = stubFetch((_url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  });
  await deliverNotice({ ...configuredEnv(), ...extra } as Env, TARGET, notice("review", CHANGES), VERSIONS);
  restore();
  return [String(sent.text), String(sent.html)];
}

test("a notice carries a link that verifies against the signing secret", async () => {
  const secret = "notice-link-secret-for-tests";
  const bodies = await bodiesFrom({ NOTICE_LINK_SECRET: secret, NOTICE_LINK_ORIGIN: "https://watch.example.test/" });
  const id = notice("review", []).id;

  const prefix = `https://watch.example.test/notice/${id}?t=`;
  for (const body of bodies) {
    const index = body.indexOf(prefix);
    assert.notEqual(index, -1, "both bodies carry the link");

    const supplied = body.slice(index + prefix.length).match(/^[a-f0-9]{64}/)?.[0];
    assert.ok(supplied, "the link carries a full-length token");
    assert.equal(await verifyNoticeLinkToken(id, supplied, secret), true, "the token in the email is the one the Worker will accept");
    // The trailing slash on the configured origin must not produce a double slash.
    assert.doesNotMatch(body, /example\.test\/\/notice/);
  }
});

test("no signing secret means no link, not an unsigned one", async () => {
  for (const configuration of [
    {},
    { NOTICE_LINK_SECRET: "s" },
    { NOTICE_LINK_ORIGIN: "https://watch.example.test" }
  ]) {
    for (const body of await bodiesFrom(configuration)) {
      assert.doesNotMatch(body, /\/notice\//, `a link was rendered with ${JSON.stringify(configuration)}`);
    }
  }
});
