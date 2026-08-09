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

export async function deliverNotice(env: Env, target: WatchTargetRecord, notice: ChangeNoticeRecord, versions: { baseline: string; candidate: string }): Promise<DeliveryOutcome> {
  if (!deliveryConfigured(env)) {
    return { state: "not_configured", detail: "No delivery channel is configured: set RESEND_API_KEY, NOTIFY_FROM and NOTIFY_TO." };
  }

  const changes = parseChanges(notice.changes_json);
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
        text: renderText(target, notice, changes, versions),
        html: renderHtml(target, notice, changes, versions)
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

const SEVERITY_NOTE: Record<string, string> = {
  high: "The capability this server declares has grown, or code now runs that did not run before.",
  review: "Something you approved has changed. Worth reading before you upgrade.",
  info: "Recorded for completeness. Not a reason to act on its own."
};

function renderText(target: WatchTargetRecord, notice: ChangeNoticeRecord, changes: WatchChange[], versions: { baseline: string; candidate: string }): string {
  const lines = [
    `${target.package_name}`,
    `${versions.baseline} -> ${versions.candidate}`,
    "",
    SEVERITY_NOTE[notice.severity] ?? SEVERITY_NOTE.review,
    "",
    `${changes.length} change${changes.length === 1 ? "" : "s"} from the baseline you approved:`,
    ""
  ];
  for (const change of changes) {
    lines.push(`  [${change.severity}] ${change.kind}`);
    lines.push(`      ${change.summary}`);
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

function renderHtml(target: WatchTargetRecord, notice: ChangeNoticeRecord, changes: WatchChange[], versions: { baseline: string; candidate: string }): string {
  const rows = changes.map((change) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eaecf0;white-space:nowrap;color:${SEVERITY_COLOUR[change.severity] ?? "#475467"};font-weight:600">${escapeHtml(change.severity)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eaecf0;white-space:nowrap;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(change.kind)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eaecf0">${escapeHtml(change.summary)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;font-family:ui-sans-serif,system-ui,sans-serif;color:#101828">
<div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #eaecf0;border-radius:12px;padding:24px">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085">Sentinel change notice</p>
  <h1 style="margin:0 0 4px;font-size:20px;font-family:ui-monospace,monospace">${escapeHtml(target.package_name)}</h1>
  <p style="margin:0 0 16px;font-size:15px;color:#475467"><code>${escapeHtml(versions.baseline)}</code> &rarr; <code>${escapeHtml(versions.candidate)}</code></p>
  <p style="margin:0 0 20px;padding:12px 14px;border-radius:8px;background:#f9fafb;border-left:3px solid ${SEVERITY_COLOUR[notice.severity] ?? "#475467"};font-size:14px">
    ${escapeHtml(SEVERITY_NOTE[notice.severity] ?? SEVERITY_NOTE.review ?? "")}
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr>
      <th align="left" style="padding:0 12px 8px;font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.05em">Severity</th>
      <th align="left" style="padding:0 12px 8px;font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.05em">Change</th>
      <th align="left" style="padding:0 12px 8px;font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.05em">Detail</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
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
