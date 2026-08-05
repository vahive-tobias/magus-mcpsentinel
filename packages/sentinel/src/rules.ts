import { createHash } from "node:crypto";
import type { AgentTextSpan } from "./tool-surface.js";

/**
 * Sentinel rule pack v0.1.
 *
 * Every rule states a verifiable fact about the artifact. None of them decides
 * whether a package is safe: severity and confidence are inputs to an operator's
 * policy, not a verdict. This is the "keep policy downstream" commitment in
 * practice.
 *
 * Two invariants matter for downstream consumers:
 *
 * 1. A finding `summary` must be STABLE across releases. Consumers key findings
 *    by category and summary to decide what is new, so an offset or line number
 *    in a summary would manufacture a phantom removal plus addition on every
 *    unrelated edit. Locations belong in `evidence.byte_range`.
 * 2. Rule output must be deterministic. Findings are sorted by id before return.
 */

export const RULE_PACK_VERSION = "0.1.0";

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";

export interface RuleDefinition {
  id: string;
  version: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  /** Included in the rule pack digest so a rule change is always visible. */
  signature: string;
}

/** npm executes these on the operator's machine during `npm install`. */
const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"];

/**
 * Characters that are invisible or that reorder rendered text. None of these has
 * a legitimate place in a tool name or description, and all of them can hide
 * instructions from a human reviewing the same text a model will read.
 */
const INVISIBLE_CHARACTERS = [
  { start: 0x00ad, end: 0x00ad, note: "soft hyphen" },
  { start: 0x180e, end: 0x180e, note: "mongolian vowel separator" },
  { start: 0x200b, end: 0x200f, note: "zero-width and directional marks" },
  { start: 0x202a, end: 0x202e, note: "bidirectional override" },
  { start: 0x2060, end: 0x2064, note: "word joiner and invisible operators" },
  { start: 0x2066, end: 0x2069, note: "bidirectional isolate" },
  { start: 0xfeff, end: 0xfeff, note: "zero-width no-break space" },
  { start: 0xe0000, end: 0xe007f, note: "unicode tag characters" }
];

/**
 * Instruction-override phrasing. Deliberately narrow: each pattern targets a
 * construction that is hard to write by accident in a tool description. Reported
 * at low confidence because this is a heuristic, not a proof.
 */
const OVERRIDE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "ignore-previous-instructions", pattern: /\b(?:ignore|disregard)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directions?)\b/i },
  { id: "do-not-tell-the-user", pattern: /\bdo\s+not\s+(?:tell|inform|notify|mention\s+(?:this\s+)?to)\s+the\s+user\b/i },
  { id: "without-informing-the-user", pattern: /\bwithout\s+(?:telling|informing|notifying|asking)\s+the\s+user\b/i },
  { id: "new-instructions-marker", pattern: /\bnew\s+instructions?\s*:/i },
  { id: "override-your-instructions", pattern: /\boverride\s+(?:your|the|all)\s+(?:previous\s+|system\s+|prior\s+)?instructions?\b/i }
];

const RULES: RuleDefinition[] = [
  {
    id: "install-lifecycle-script",
    version: "0.1.0",
    category: "unsafe_default",
    severity: "medium",
    confidence: "high",
    signature: INSTALL_LIFECYCLE_SCRIPTS.join(",")
  },
  {
    id: "invisible-unicode-in-agent-text",
    version: "0.1.0",
    category: "hidden_instruction",
    severity: "high",
    confidence: "high",
    signature: INVISIBLE_CHARACTERS.map((range) => `${range.start.toString(16)}-${range.end.toString(16)}`).join(",")
  },
  {
    id: "instruction-override-phrase",
    version: "0.1.0",
    category: "instruction_override",
    severity: "medium",
    confidence: "low",
    signature: OVERRIDE_PATTERNS.map((entry) => `${entry.id}:${entry.pattern.source}`).join(",")
  }
];

/**
 * Digest of the rule definitions themselves, so `analysis.rule_pack.sha256`
 * identifies the exact rules that produced a report. Changing a pattern changes
 * this digest, which is what makes an old report re-checkable rather than merely
 * re-runnable.
 */
export function rulePackSha256(): string {
  const canonical = JSON.stringify({
    version: RULE_PACK_VERSION,
    rules: RULES.map((rule) => [rule.id, rule.version, rule.category, rule.severity, rule.confidence, rule.signature])
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface Evidence {
  sha256: string;
  artifact_path?: string;
  byte_range?: [number, number];
  capture_kind: string;
}

export interface Finding {
  id: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  detector: { kind: "rule"; id: string; version: string };
  evidence: Evidence[];
  summary: string;
  interpretation?: string;
}

export interface RuleInput {
  packageJson: Record<string, unknown>;
  packageJsonEvidence: Evidence;
  agentText: AgentTextSpan[];
}

export function evaluateRules(input: RuleInput): Finding[] {
  const findings: Finding[] = [
    ...installLifecycleScripts(input),
    ...invisibleUnicode(input),
    ...instructionOverridePhrases(input)
  ];
  return findings.sort((left, right) => left.id.localeCompare(right.id));
}

function rule(id: string): RuleDefinition {
  const definition = RULES.find((entry) => entry.id === id);
  if (!definition) throw new Error(`Unknown rule ${id}.`);
  return definition;
}

function installLifecycleScripts(input: RuleInput): Finding[] {
  const scripts = input.packageJson.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  const declared = scripts as Record<string, unknown>;
  const definition = rule("install-lifecycle-script");

  return INSTALL_LIFECYCLE_SCRIPTS
    .filter((name) => typeof declared[name] === "string" && (declared[name] as string).trim().length > 0)
    .map((name) => ({
      id: `finding:install-lifecycle-script.${name}`,
      category: definition.category,
      severity: definition.severity,
      confidence: definition.confidence,
      detector: { kind: "rule" as const, id: definition.id, version: definition.version },
      evidence: [input.packageJsonEvidence],
      summary: `Package declares the ${name} lifecycle script.`,
      interpretation: `npm runs this command on the installing machine during installation, before the server is ever started. Its presence is a fact about the package, not evidence of intent.`
    }));
}

function invisibleUnicode(input: RuleInput): Finding[] {
  const definition = rule("invisible-unicode-in-agent-text");
  const findings: Finding[] = [];

  for (const span of input.agentText) {
    const found = new Set<number>();
    for (const character of span.text) {
      const code = character.codePointAt(0);
      if (code === undefined) continue;
      if (INVISIBLE_CHARACTERS.some((range) => code >= range.start && code <= range.end)) found.add(code);
    }
    if (found.size === 0) continue;

    const points = [...found].sort((left, right) => left - right).map(formatCodePoint);
    findings.push({
      id: `finding:invisible-unicode.${slug(span.toolName)}.${span.kind === "tool_name" ? "name" : "description"}`,
      category: definition.category,
      severity: definition.severity,
      confidence: definition.confidence,
      detector: { kind: "rule" as const, id: definition.id, version: definition.version },
      evidence: [{
        sha256: span.fileSha256,
        artifact_path: span.artifactPath,
        byte_range: span.byteRange,
        capture_kind: "artifact_file"
      }],
      summary: `Tool ${JSON.stringify(span.toolName)} ${span.kind === "tool_name" ? "name" : "description"} contains invisible or direction-altering Unicode (${points.join(", ")}).`,
      interpretation: "These code points are not rendered, or they reorder rendered text. Text a reviewer sees may differ from text the model receives."
    });
  }

  return findings;
}

function instructionOverridePhrases(input: RuleInput): Finding[] {
  const definition = rule("instruction-override-phrase");
  const findings: Finding[] = [];

  for (const span of input.agentText) {
    if (span.kind !== "tool_description") continue;
    for (const { id, pattern } of OVERRIDE_PATTERNS) {
      if (!pattern.test(span.text)) continue;
      findings.push({
        id: `finding:instruction-override.${slug(span.toolName)}.${id}`,
        category: definition.category,
        severity: definition.severity,
        confidence: definition.confidence,
        detector: { kind: "rule" as const, id: definition.id, version: definition.version },
        evidence: [{
          sha256: span.fileSha256,
          artifact_path: span.artifactPath,
          byte_range: span.byteRange,
          capture_kind: "artifact_file"
        }],
        // The matched text is deliberately not quoted here: the summary must stay
        // stable, and package text belongs in the evidence range, not the alert.
        summary: `Tool ${JSON.stringify(span.toolName)} description matches instruction-override pattern ${JSON.stringify(id)}.`,
        interpretation: "A low-confidence lexical match. Descriptions are supplied to the model as instructions, so this phrasing is worth reading in context; it is not proof of intent."
      });
    }
  }

  return findings;
}

function formatCodePoint(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Finding ids are constrained to `^finding:[a-z0-9._-]+$` by the report schema. */
function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "unnamed";
}
