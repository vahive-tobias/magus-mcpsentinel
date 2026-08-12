import { diffReports } from "mcp-sentinel/diff";
import type { ChangeKind, ReportChange } from "mcp-sentinel/diff";
import type { SentinelReport } from "mcp-sentinel/report-contract";
import type { ChangeNotice, Severity, WatchChange } from "./types.js";

/**
 * Watch's review policy.
 *
 * The analyzer decides *what* changed. This module decides *how much it matters*,
 * which is a product judgement and belongs here rather than in the engine. Editing
 * this file changes how alerts are ranked; it cannot change what is detected.
 */

/** Static API indicators that materially widen what a server can reach. */
const HIGH_RISK_INDICATORS = new Set(["process-spawn-api", "network-api"]);

/**
 * How much a lost tool surface matters, by the extractor's reason for losing it.
 *
 * The line is whose property the loss is. `high` means the package stopped
 * declaring its surface in a form anything can read — either the source itself
 * became unreadable, or the tool list moved from a literal to something computed
 * at runtime. Those are obfuscation, minification and dynamic registration, which
 * are the three shapes a rug-pull arrives in.
 *
 * `review` means our extractor ran out of reach: it does not parse TypeScript, it
 * recognises a fixed set of registration shapes, and it falls back to definition
 * literals with weaker provenance. A refactor produces those as readily as
 * concealment does, and the package may not have moved at all.
 *
 * Every reason the analyzer can emit must appear here. `policy.test.ts` reads them
 * out of the extractor and fails on any that does not — an unclassified reason
 * would otherwise take the fallback below and rank as though it were understood.
 */
const COVERAGE_LOSS_SEVERITY: Record<string, Severity> = {
  source_file_failed_to_parse: "high",
  source_file_exceeded_parse_size_limit: "high",
  registration_name_not_static: "high",
  list_tools_handler_not_static: "high",
  list_tools_array_not_static: "high",
  list_tools_array_uses_spread: "high",
  list_tools_entry_not_static: "high",
  list_tools_entry_name_not_static: "high",
  typescript_source_not_parsed: "review",
  no_recognized_registration_pattern: "review",
  tools_inferred_from_definitions_only: "review",
  // A task registration in a receiver shape this extractor does not walk. The
  // package declared it perfectly ordinarily; the limit is ours.
  task_registration_shape_not_recognized: "review",
  // Entrypoint code loads a file that path shape excluded from the tool-surface
  // scan. The exclusion is our approximation, so the uncertainty is ours.
  entrypoint_loads_excluded_path: "review"
};

export const CLASSIFIED_COVERAGE_LOSS_REASONS = Object.keys(COVERAGE_LOSS_SEVERITY);

/**
 * Default severity per change kind.
 *
 * `high`   — the effective capability handed to an agent has grown, or code now
 *            runs that did not run before. Review before updating.
 * `review` — a real change to something previously approved. Read it.
 * `info`   — context. Not a reason to act on its own.
 */
const SEVERITY: Record<ChangeKind, Severity> = {
  tool_added: "high",
  tool_schema_changed: "review",
  tool_description_changed: "review",
  entrypoint_changed: "high",
  install_script_changed: "high",
  server_identity_changed: "high",
  indicator_added: "review",
  finding_added: "review",
  artifact_changed: "review",
  dependency_added: "review",
  dependency_removed: "review",
  dependency_changed: "review",
  // A skill is a document a model reads as instructions, and mcp.json says which
  // servers run and over what transport. Both change what an agent will do
  // without necessarily changing a line of executable code, which is the exact
  // shape this tool exists to surface. `severityFor` lowers these where the
  // change is a removal.
  skill_changed: "high",
  mcp_declaration_changed: "high",
  plugin_manifest_changed: "review",
  tool_removed: "info",
  indicator_removed: "info",
  script_changed: "info",
  metadata_changed: "info",
  file_inventory_changed: "info",
  // Every release edits files. Ranking that above "context" would put a banner on
  // every notice and teach the reader to ignore all of them.
  file_content_changed: "info",
  finding_removed: "info",
  comparison_limited: "info",
  // Raised by reason in `severityFor`. A package that got harder to read is worth
  // more than context, and an unrecorded reason must not read as the benign case.
  coverage_regressed: "review"
};

export function createChangeNotice(baselineReport: SentinelReport, candidateReport: SentinelReport): ChangeNotice {
  const diff = diffReports(baselineReport, candidateReport);
  const changes: WatchChange[] = diff.changes.map((change) => ({
    kind: change.kind,
    severity: severityFor(change),
    summary: change.summary,
    ...(change.detail ? { detail: change.detail } : {})
  }));

  const summary = changes.length === 0
    ? `${diff.packageName}@${diff.candidateVersion} has no normalized changes from the approved baseline.`
    : `${diff.packageName}@${diff.candidateVersion} has ${changes.length} reviewable change${changes.length === 1 ? "" : "s"} from ${diff.baselineVersion}.`;

  return { severity: highestSeverity(changes), summary, changes };
}

/**
 * Escalate above the default where the change detail shows the capability surface
 * actually grew, rather than merely moved.
 */
function severityFor(change: ReportChange): Severity {
  const detail = change.detail ?? {};

  if (change.kind === "tool_schema_changed") {
    // A widened schema accepts input it previously refused. A narrowed one does not.
    const added = detail.addedProperties;
    return Array.isArray(added) && added.length > 0 ? "high" : "review";
  }

  if (change.kind === "indicator_added" && typeof detail.indicator === "string") {
    return HIGH_RISK_INDICATORS.has(detail.indicator) ? "high" : "review";
  }

  if (change.kind === "finding_added") {
    return detail.severity === "high" || detail.severity === "critical" ? "high" : "review";
  }

  if (change.kind === "coverage_regressed") {
    // Several reasons can arrive together and the strongest decides. A reason this
    // policy does not know is a report from a newer analyzer than this monitor:
    // it still lost coverage, so it ranks as a change to read rather than as noise.
    const reasons = Array.isArray(detail.reasons) ? detail.reasons : [];
    const severities = reasons
      .filter((reason): reason is string => typeof reason === "string")
      .map((reason) => COVERAGE_LOSS_SEVERITY[reason] ?? "review");
    return severities.includes("high") ? "high" : "review";
  }

  // A declared-surface file that appeared hands the agent something it did not
  // have before; one that was rewritten is a change to read; one that vanished is
  // a capability the agent lost. Same ordering as tools.
  if (change.kind === "skill_changed" || change.kind === "mcp_declaration_changed") {
    if (detail.state === "removed") return "info";
    return detail.state === "added" ? "high" : "review";
  }

  return SEVERITY[change.kind] ?? "review";
}

function highestSeverity(changes: WatchChange[]): Severity {
  if (changes.some((change) => change.severity === "high")) return "high";
  if (changes.some((change) => change.severity === "review")) return "review";
  return "info";
}
