import { noticeLinkToken } from "./auth.js";
import type { ChangeNoticeRecord, Env, WatchChange, WatchTargetRecord } from "./types.js";

/**
 * Delivering the change notice.
 *
 * This is the product. Someone is paying so that an email arrives when a package
 * they approved has moved, and everything else in this repository exists to make
 * that email accurate. So it states what changed and what the evidence is, and it
 * does not tell the reader what to conclude — the severity is Watch's ranking of
 * how urgently to look, never a verdict on the package.
 */

export interface DeliveryOutcome {
  state: "sent" | "failed" | "not_configured";
  detail: string;
}

interface ResendError {
  message?: string;
  name?: string;
}

export function deliveryConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.NOTIFY_FROM && env.NOTIFY_TO);
}

/**
 * Where a notice link points, or nothing.
 *
 * A configured origin that is not an absolute http(s) URL is treated as absent.
 * Checking only that the value was *set* is what put `hnhdyl70k…/notice/…` in
 * four delivered notices: a browser reads that as a hostname, so every button
 * failed DNS. Presence was never the property that mattered.
 *
 * `URL.origin` is what is kept, so a value carrying a path loses it rather than
 * producing a link the Worker does not serve — `/notice/…` is at the root.
 */
function noticeOrigin(configured: string | undefined): string | undefined {
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The capability link for this notice, when one can be signed and reached.
 *
 * No secret or no usable origin means no link, and the notice reads exactly as it
 * did before. A link that cannot be honoured is worse than none: the reader clicks
 * it, gets an error, and learns that the product does not work.
 */
async function noticeLink(env: Env, noticeId: string): Promise<string | undefined> {
  const origin = noticeOrigin(env.NOTICE_LINK_ORIGIN);
  if (!env.NOTICE_LINK_SECRET || !origin) return undefined;
  const token = await noticeLinkToken(noticeId, env.NOTICE_LINK_SECRET);
  return `${origin}/notice/${noticeId}?t=${token}`;
}

export async function deliverNotice(env: Env, target: WatchTargetRecord, notice: ChangeNoticeRecord, versions: { baseline: string; candidate: string }): Promise<DeliveryOutcome> {
  if (!deliveryConfigured(env)) {
    return { state: "not_configured", detail: "No delivery channel is configured: set RESEND_API_KEY, NOTIFY_FROM and NOTIFY_TO." };
  }

  const changes = parseChanges(notice.changes_json);
  const link = await noticeLink(env, notice.id);
  const subject = subjectLine(target.package_name, versions.candidate, notice.severity, changes.length);

  try {
    const response = await fetch(env.RESEND_ENDPOINT ?? "https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: env.NOTIFY_FROM,
        to: [env.NOTIFY_TO],
        subject,
        text: renderText(target, notice, changes, versions, link),
        html: renderHtml(target, notice, changes, versions, link)
      }),
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      // The provider's own message is far more useful than a status code alone
      // when someone is working out why a notice did not arrive.
      const body = await response.text();
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(body) as ResendError;
        if (parsed.message) detail = `HTTP ${response.status}: ${parsed.message}`;
      } catch {
        if (body) detail = `HTTP ${response.status}: ${body.slice(0, 200)}`;
      }
      return { state: "failed", detail };
    }

    return { state: "sent", detail: `Delivered to ${env.NOTIFY_TO}.` };
  } catch (error) {
    return { state: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

function parseChanges(json: string): WatchChange[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as WatchChange[] : [];
  } catch {
    return [];
  }
}

function subjectLine(packageName: string, version: string, severity: string, count: number): string {
  const lead = severity === "high" ? "Review before upgrading" : "Changed";
  return `[Sentinel] ${lead}: ${packageName}@${version} (${count} change${count === 1 ? "" : "s"})`;
}

/**
 * How many named items a single change may show before the rest are counted.
 *
 * The analyzer already caps the paths it names for an edited-file change; an
 * inventory change is uncapped, because a report keeps its evidence in full. This
 * is the display limit, and display is Watch's problem, not the analyzer's.
 */
const NAMED_ITEM_LIMIT = 10;

interface NamedItem {
  /** `+` added, `-` removed, blank otherwise — the ordinary diff reading. */
  marker: string;
  value: string;
}

/**
 * The concrete items behind a change's summary.
 *
 * A summary states a count: "1 added, 0 removed", "3 files changed contents". The
 * names are what let someone go and look, and a tool whose whole claim is
 * transparency should not make them ask for them.
 *
 * Any string array in the detail qualifies, so a change kind added later needs no
 * work here. Items the summary already names are skipped rather than repeated —
 * that is what keeps a widened tool schema, whose summary lists its new fields,
 * from printing them twice.
 */
function namedItems(change: WatchChange): { items: NamedItem[]; omitted: number } {
  const detail = change.detail ?? {};
  const items: NamedItem[] = [];
  let total = 0;

  for (const [key, value] of Object.entries(detail)) {
    if (!Array.isArray(value)) continue;
    const marker = key === "added" ? "+" : key === "removed" ? "-" : "";
    for (const entry of value) {
      if (typeof entry !== "string" || change.summary.includes(entry)) continue;
      total += 1;
      if (items.length < NAMED_ITEM_LIMIT) items.push({ marker, value: entry });
    }
  }

  // `count` is how many there really were; `paths` is what the analyzer chose to
  // name. Reporting the difference stops a capped list from reading as the whole.
  const declared = typeof detail.count === "number" ? detail.count : 0;
  const omitted = Math.max(total - items.length, declared - total);
  return { items, omitted };
}

/**
 * How a severity reads to someone who does not work in this vocabulary.
 *
 * `info` is the one that matters: it is a machine word that tells a reader
 * nothing, and on a page that most people meet once, next to a package they are
 * deciding whether to upgrade, "Context" says what it actually is. The stored
 * values are unchanged — this is presentation, and the API still speaks
 * `high`/`review`/`info`.
 *
 * The public watch page uses these same three words. One product, one language.
 */
const SEVERITY_LABEL: Record<string, string> = {
  high: "Worth reading",
  review: "Review",
  info: "Context"
};

const SEVERITY_NOTE: Record<string, string> = {
  high: "The capability this server declares has grown, or code now runs that did not run before.",
  review: "Something you approved has changed. Worth reading before you upgrade.",
  info: "Recorded for completeness. Not a reason to act on its own."
};

function renderText(target: WatchTargetRecord, notice: ChangeNoticeRecord, changes: WatchChange[], versions: { baseline: string; candidate: string }, link?: string): string {
  const lines = [
    `${target.package_name}`,
    `${versions.baseline} -> ${versions.candidate}`,
    "",
    SEVERITY_NOTE[notice.severity] ?? SEVERITY_NOTE.review,
    "",
    // The stored summary, not a count rebuilt here. Anything the monitor appends
    // to it — the count of releases published between these two versions, for one
    // — reached the database and never the reader while this line said `changes.length`.
    notice.summary,
    ""
  ];
  for (const change of changes) {
    lines.push(`  [${SEVERITY_LABEL[change.severity] ?? change.severity}] ${change.kind}`);
    lines.push(`      ${change.summary}`);
    const { items, omitted } = namedItems(change);
    for (const item of items) lines.push(`        ${item.marker ? `${item.marker} ` : ""}${item.value}`);
    if (omitted > 0) lines.push(`        … and ${omitted} more`);
  }
  if (link) {
    lines.push(
      "",
      "Read this notice and accept the new version as your baseline:",
      `  ${link}`
    );
  }
  lines.push(
    "",
    "---",
    "",
    "This compares the release against the version you approved, not against the",
    "previous release. Sentinel does not decide whether a package is safe; it",
    "reports what changed and leaves the judgement to you.",
    "",
    "The artifact digest, file inventory, dependencies, scripts and entrypoints are",
    "recorded in full on every release. The tool inventory is recovered from source",
    "and can be incomplete — a change notice never reports a missing tool as a",
    "removed one.",
    "",
    `Notice ${notice.id}`
  );
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character
  ));
}

const SEVERITY_COLOUR: Record<string, string> = { high: "#b42318", review: "#b54708", info: "#475467" };

function renderHtml(target: WatchTargetRecord, notice: ChangeNoticeRecord, changes: WatchChange[], versions: { baseline: string; candidate: string }, link?: string): string {
  const rows = changes.map((change) => {
    const { items, omitted } = namedItems(change);
    const named = items.length === 0 && omitted === 0 ? "" : `
        <ul style="margin:6px 0 0;padding:0 0 0 16px;list-style:none;font-family:ui-monospace,monospace;font-size:12px;color:#475467">
          ${items.map((item) => `<li style="margin:2px 0">${escapeHtml(item.marker ? `${item.marker} ${item.value}` : item.value)}</li>`).join("")}
          ${omitted > 0 ? `<li style="margin:2px 0;color:#98a2b3">… and ${omitted} more</li>` : ""}
        </ul>`;
    return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eaecf0;white-space:nowrap;color:${SEVERITY_COLOUR[change.severity] ?? "#475467"};font-weight:600;vertical-align:top">${escapeHtml(SEVERITY_LABEL[change.severity] ?? change.severity)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eaecf0;white-space:nowrap;font-family:ui-monospace,monospace;font-size:13px;vertical-align:top">${escapeHtml(change.kind)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eaecf0">${escapeHtml(change.summary)}${named}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;font-family:ui-sans-serif,system-ui,sans-serif;color:#101828">
<div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #eaecf0;border-radius:12px;padding:24px">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085">Sentinel change notice</p>
  <h1 style="margin:0 0 4px;font-size:20px;font-family:ui-monospace,monospace">${escapeHtml(target.package_name)}</h1>
  <p style="margin:0 0 16px;font-size:15px;color:#475467"><code>${escapeHtml(versions.baseline)}</code> &rarr; <code>${escapeHtml(versions.candidate)}</code></p>
  <p style="margin:0 0 20px;padding:12px 14px;border-radius:8px;background:#f9fafb;border-left:3px solid ${SEVERITY_COLOUR[notice.severity] ?? "#475467"};font-size:14px">
    ${escapeHtml(SEVERITY_NOTE[notice.severity] ?? SEVERITY_NOTE.review ?? "")}
  </p>
  <p style="margin:0 0 16px;font-size:14px;color:#101828">${escapeHtml(notice.summary)}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr>
      <th align="left" style="padding:0 12px 8px;font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.05em">Severity</th>
      <th align="left" style="padding:0 12px 8px;font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.05em">Change</th>
      <th align="left" style="padding:0 12px 8px;font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.05em">Detail</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${link ? `<p style="margin:24px 0 0">
    <a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#101828;color:#fff;font-size:14px;font-weight:600;text-decoration:none">Read this notice</a>
  </p>
  <p style="margin:8px 0 0;font-size:12px;color:#98a2b3">Opening the link only shows the notice. Accepting the new version as your baseline is a separate step on that page.</p>` : ""}
  <p style="margin:20px 0 0;font-size:13px;color:#475467;line-height:1.6">
    This compares the release against the version you approved, not against the previous release.
    Sentinel does not decide whether a package is safe &mdash; it reports what changed and leaves the judgement to you.
  </p>
  <p style="margin:12px 0 0;font-size:13px;color:#667085;line-height:1.6">
    Artifact digest, file inventory, dependencies, scripts and entrypoints are recorded in full on every release.
    The tool inventory is recovered from source and can be incomplete; a missing tool is never reported as a removed one.
  </p>
  <p style="margin:16px 0 0;font-size:12px;color:#98a2b3">Notice ID <span style="font-family:ui-monospace,monospace">${escapeHtml(notice.id)}</span> &mdash; quote this to look the notice up, accept it, or freeze it.</p>
</div>
</body></html>`;
}
