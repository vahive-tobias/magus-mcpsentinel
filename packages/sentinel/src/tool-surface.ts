import { createHash } from "node:crypto";
import { parse } from "acorn";
import type { TarEntry } from "./archive.js";

/**
 * Static recovery of the MCP tool surface an npm artifact appears to register.
 *
 * This module never executes package code. It parses shipped JavaScript with
 * acorn and reads only syntactically determinable values. The result is an
 * INFERENCE about the declared surface, not an observation of a running server,
 * and it is reported with `coverage: "inferred"` for exactly that reason.
 *
 * When any part of the surface cannot be resolved statically the extraction is
 * marked incomplete. A partial inventory must never be presented as a complete
 * one: a silently truncated tool list would lead a consumer to report a removed
 * tool that was never removed.
 */

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const PARSEABLE = /\.(?:m?js|cjs)$/i;
const TYPESCRIPT_SOURCE = /\.tsx?$/i;
const DECLARATION = /\.d\.[cm]?ts$/i;

/**
 * Paths whose shape says they are not the package's own tool surface.
 *
 * Measured, not guessed. Across a 50-package corpus, nine of forty-one
 * classified servers carried an incompleteness reason earned by a file like
 * `dist/node_modules/@aws-crypto/crc32/src/index.ts` or
 * `references/common-blueprints.fixtures.ts` — and `complete: false` is what
 * makes a consumer withhold removal conclusions. The same files were also in the
 * detached-definition candidate pool, so an example's tool-shaped object could
 * enter the inventory.
 *
 * This is an approximation and is deliberately narrow. It replaced an entrypoint
 * reachability closure that the same corpus disproved: a 3.9 MB bin over the
 * parse limit, or a plugin package whose surface its own `main` never reaches,
 * both lost their entire surface to it. A path rule cannot do that, because
 * nothing outside these shapes is ever excluded.
 *
 * `skills` and `templates` are deliberately absent. Both names are overloaded
 * enough that a package may legitimately ship production code under them, and
 * widening on a name rather than on evidence is how this becomes the bug it
 * replaced.
 *
 * Scope: tool-surface parsing and definition discovery only. The file inventory
 * and the static API indicators still read the whole artifact — Sentinel does not
 * stop observing that these files exist, it stops letting them speak for the
 * tool surface.
 */
const EXCLUDED_PATH_COMPONENTS = new Set(["node_modules", "examples", "fixtures", "test", "tests", "__tests__"]);
const EXCLUDED_FILENAME_MARKERS = [".test.", ".spec.", ".fixture.", ".fixtures."];

export function isOutsideToolSurface(artifactPath: string): boolean {
  const segments = artifactPath.split("/");
  const basename = segments[segments.length - 1] ?? "";
  if (segments.some((segment) => EXCLUDED_PATH_COMPONENTS.has(segment))) return true;
  return EXCLUDED_FILENAME_MARKERS.some((marker) => basename.includes(marker));
}

/** Entrypoints declared by the manifest, resolved to artifact paths. */
function declaredEntrypoints(entries: TarEntry[]): string[] {
  const manifest = entries.find((entry) => /^[^/]+\/package\.json$/.test(entry.path));
  const raw = manifest?.contents?.toString("utf8");
  if (!manifest || !raw) return [];

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return []; }

  const declared: string[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (typeof value === "string") { declared.push(value); return; }
    if (depth > 6 || !value || typeof value !== "object") return;
    for (const nested of Object.values(value as Record<string, unknown>)) collect(nested, depth + 1);
  };
  collect(parsed.main); collect(parsed.module); collect(parsed.bin); collect(parsed.exports);

  const prefix = manifest.path.slice(0, manifest.path.lastIndexOf("/"));
  const known = new Set(entries.map((entry) => entry.path));
  const resolved: string[] = [];
  for (const target of declared) {
    const base = `${prefix}/${target.replace(/^\.\//, "")}`.replace(/\/+/g, "/");
    for (const suffix of ["", ".js", ".mjs", ".cjs", "/index.js", "/index.mjs", "/index.cjs"]) {
      if (known.has(`${base}${suffix}`)) { resolved.push(`${base}${suffix}`); break; }
    }
  }
  return resolved;
}

/** Every literal module specifier in a source, relative or bare. */
const LITERAL_SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"'\n]+)["']/g;

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Does entrypoint code load something path shape excluded?
 *
 * Path shape is an approximation, not proof a file is irrelevant at runtime.
 * Excluding `node_modules` wholesale could produce the same false completeness in
 * reverse — a vendored dependency that is loaded and registers tools would be
 * dropped in silence.
 *
 * So the roots' own literal edges are checked, deliberately shallow: one level,
 * no closure, none of the entrypoint-graph machinery the corpus already
 * disproved. A bare specifier matters as much as a relative one, because a
 * bundler that emits `dist/node_modules/xml2js` loads it with
 * `require("xml2js")` — the dangerous case, and invisible to a relative check.
 *
 * The file stays out of parsing: reading vendored SDK examples is what produced
 * twenty-one false tools. What changes is the claim. The surface is reported
 * incomplete rather than complete-minus-what-we-chose-not-to-read.
 */
function entrypointsReachExcludedPaths(entries: TarEntry[]): boolean {
  const roots = declaredEntrypoints(entries);
  if (roots.length === 0) return false;

  const excluded = entries.filter((entry) => entry.type === "file" && isOutsideToolSurface(entry.path));
  if (excluded.length === 0) return false;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  for (const root of roots) {
    const source = byPath.get(root)?.contents?.toString("utf8");
    if (!source) continue;
    const base = root.slice(0, root.lastIndexOf("/"));
    LITERAL_SPECIFIER.lastIndex = 0;
    for (const match of source.matchAll(LITERAL_SPECIFIER)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const target = normalizePath(`${base}/${specifier}`);
        if (excluded.some((entry) => entry.path === target || entry.path.startsWith(`${target}/`))) return true;
        continue;
      }
      const scoped = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
      if (excluded.some((entry) => entry.path.includes(`/node_modules/${scoped}/`))) return true;
    }
  }
  return false;
}

/** Registration helpers exposed by the MCP TypeScript SDK's high-level server. */
const REGISTRATION_METHODS = new Set(["tool", "registerTool"]);

/** Registrations whose second argument is a config object rather than a variadic tail. */
const CONFIG_STYLE_REGISTRATIONS = new Set(["registerTool", "registerToolTask"]);

/**
 * The receiver path a task registration must sit on.
 *
 * Matched as an exact shape — `<receiver>.experimental.tasks.registerToolTask` —
 * rather than by method name alone. A bare `registerToolTask` on any object
 * would be a suffix match, and this extractor's precision comes from refusing
 * those: a tool that does not exist becomes a phantom removal on the next
 * release.
 */
const TASK_REGISTRATION_PATH = ["tasks", "experimental"];

/**
 * Schema keys distinctive enough that a static `name` beside one is evidence.
 *
 * `inputSchema` is the MCP tool-definition field. `zodSchema` is what a Standard
 * Schema implementation looks like once built — measured in
 * `@transcend-io/mcp-server-docs`, whose tools carry no `inputSchema` at all.
 * Neither key appears on ordinary configuration objects.
 */
const DISTINCTIVE_SCHEMA_KEYS = ["inputSchema", "input_schema", "zodSchema"];

/**
 * Schema keys that are common outside MCP and cannot stand alone.
 *
 * `parameters` is how `firecrawl-mcp` keys its schemas, and also how every
 * OpenAI-style function descriptor does. `{ name, parameters }` is not evidence
 * of a tool by itself, so it counts only beside a field that a route table, a
 * config entry or a CLI flag definition would not carry.
 *
 * `schema` and `arguments` are deliberately absent. They collide far more
 * widely, and each is worth measuring on its own rather than inside a change
 * whose precision would then be unattributable.
 */
const CORROBORATED_SCHEMA_KEYS = ["parameters"];

/** What must appear beside an ambiguous schema key for the object to qualify. */
const TOOL_CORROBORATION = ["description", "annotations", "handler"];

export type ValueRepresentation = "json_literal" | "string_literal" | "source_text";

export interface ExtractedTool {
  name: string;
  /**
   * How the tool was recovered.
   *
   * `registration` — found at a call site that registers it with a server.
   * `definition`  — found as a tool-definition literal in source. The definition
   *                 exists; that it is actually registered is not proven.
   */
  discovery: "registration" | "definition";
  description_sha256?: string;
  description_repr?: ValueRepresentation;
  input_schema_sha256?: string;
  input_schema_repr?: ValueRepresentation;
  /** Top-level property names, available only when the schema was a static literal. */
  input_schema_properties?: string[];
  artifact_path: string;
  byte_range: [number, number];
}

/**
 * A span of text that an MCP client hands to a model.
 *
 * These carry raw package text and are deliberately NOT part of the report. They
 * exist so rules can be evaluated against what an agent would actually read; only
 * the resulting findings, which reference the text by digest and byte range, are
 * serialized.
 */
export interface AgentTextSpan {
  kind: "tool_name" | "tool_description";
  toolName: string;
  text: string;
  artifactPath: string;
  fileSha256: string;
  byteRange: [number, number];
}

export interface ToolSurface {
  tools: ExtractedTool[];
  /** False when any registration site could not be fully resolved statically. */
  complete: boolean;
  /** Stable, sorted reasons the extraction may be missing tools. */
  incompleteness: string[];
  scanned_files: string[];
  /** Rule-evaluation input only. Never serialized into a report. */
  agentText: AgentTextSpan[];
}

interface FileContext {
  source: string;
  artifactPath: string;
  fileSha256: string;
}

/** A tool plus the agent-visible text it contributes, collected together. */
interface BuiltTool {
  tool: ExtractedTool;
  spans: AgentTextSpan[];
}

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export function extractToolSurface(entries: TarEntry[]): ToolSurface {
  const tools = new Map<string, ExtractedTool>();
  const incompleteness = new Set<string>();
  const scanned: string[] = [];
  const agentText: AgentTextSpan[] = [];
  const definitions = new Map<string, BuiltTool>();
  let registrationSites = 0;
  let excludedAny = false;

  const files = entries
    .filter((entry) => entry.type === "file" && entry.contents !== undefined)
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const entry of files) {
    // Vendored code, a fixture or an example cannot cost this package its
    // authority to report a removal, and cannot contribute a candidate tool.
    if (isOutsideToolSurface(entry.path)) {
      excludedAny = true;
      continue;
    }
    if (TYPESCRIPT_SOURCE.test(entry.path) && !DECLARATION.test(entry.path)) {
      // acorn cannot parse TypeScript syntax. Record the gap rather than
      // implying the shipped .ts sources contained no registrations.
      incompleteness.add("typescript_source_not_parsed");
      continue;
    }
    if (!PARSEABLE.test(entry.path)) continue;
    const contents = entry.contents;
    if (!contents) continue;
    if (contents.byteLength > MAX_SOURCE_BYTES) {
      incompleteness.add("source_file_exceeded_parse_size_limit");
      continue;
    }

    const source = contents.toString("utf8");
    const program = parseSource(source);
    if (!program) {
      incompleteness.add("source_file_failed_to_parse");
      continue;
    }
    scanned.push(entry.path);
    const context: FileContext = { source, artifactPath: entry.path, fileSha256: sha256(contents) };
    registrationSites += collectFromProgram(program, context, tools, incompleteness, agentText);
    collectToolDefinitions(program, context, definitions);
  }

  // Definitions are merged only for names no registration site claimed, so a
  // directly registered tool always wins and keeps its stronger provenance.
  let usedDefinition = false;
  for (const name of [...definitions.keys()].sort()) {
    const built = definitions.get(name);
    if (!built || tools.has(name)) continue;
    addTool(tools, built, agentText);
    usedDefinition = true;
  }
  if (usedDefinition) {
    // The definition is present in the artifact. Whether the server actually
    // registers it cannot be established without running the server, so the
    // inventory is a lower bound rather than a confirmed surface.
    incompleteness.add("tools_inferred_from_definitions_only");
  }

  // Finding nothing is not the same as finding that there is nothing. If no
  // registration site was recognized at all, the tool list is unknown rather
  // than empty, and must never be reported as a complete inventory: a later
  // release whose tools *are* recognized would otherwise look like a package
  // that suddenly grew its entire surface.
  if (registrationSites === 0) {
    incompleteness.add("no_recognized_registration_pattern");
  }

  // Path shape decided these files do not speak for the surface. If entrypoint
  // code loads one anyway, that decision is an assumption rather than a fact, and
  // the surface is unknown rather than complete.
  if (excludedAny && entrypointsReachExcludedPaths(entries)) {
    incompleteness.add("entrypoint_loads_excluded_path");
  }

  return {
    tools: [...tools.values()].sort((left, right) => left.name.localeCompare(right.name)),
    complete: incompleteness.size === 0,
    incompleteness: [...incompleteness].sort(),
    scanned_files: scanned,
    agentText: agentText.sort((left, right) =>
      left.toolName.localeCompare(right.toolName) || left.kind.localeCompare(right.kind))
  };
}

/**
 * Convert acorn's UTF-16 character offsets into byte offsets.
 *
 * Evidence byte ranges must be byte-accurate, and the rules that matter most here
 * fire precisely on non-ASCII text, where the two offsets diverge.
 */
function toByteRange(source: string, start: number, end: number): [number, number] {
  return [Buffer.byteLength(source.slice(0, start), "utf8"), Buffer.byteLength(source.slice(0, end), "utf8")];
}

function parseSource(source: string): AstNode | undefined {
  for (const sourceType of ["module", "script"] as const) {
    try {
      return parse(source, {
        ecmaVersion: "latest",
        sourceType,
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true
      }) as unknown as AstNode;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** @returns the number of recognized tool-registration sites seen in this file. */
function collectFromProgram(
  program: AstNode,
  context: FileContext,
  tools: Map<string, ExtractedTool>,
  incompleteness: Set<string>,
  agentText: AgentTextSpan[]
): number {
  const moduleConstants = moduleScopeArrays(program);
  let sites = 0;

  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee as AstNode | undefined;
    if (!callee || callee.type !== "MemberExpression") return;
    const method = memberName(callee);
    if (!method) return;
    const args = (node.arguments as AstNode[] | undefined) ?? [];

    if (REGISTRATION_METHODS.has(method) && args.length >= 2) {
      sites += 1;
      collectRegistrationCall(method, node, args, context, tools, incompleteness, agentText);
      return;
    }
    if (method === "registerToolTask") {
      // A task is still an advertised tool, so it earns the same `registration`
      // provenance. How it behaves when invoked is not a discovery question.
      if (!onTaskRegistrationPath(callee) || args.length < 2) {
        // Seen but not in the shape this understands. Saying so is what keeps a
        // surface that is missing a task from being reported as complete.
        incompleteness.add("task_registration_shape_not_recognized");
        return;
      }
      sites += 1;
      collectRegistrationCall(method, node, args, context, tools, incompleteness, agentText);
      return;
    }
    if (method === "setRequestHandler" && mentionsListTools(args[0])) {
      sites += 1;
      collectListToolsHandler(args[1], context, moduleConstants, tools, incompleteness, agentText);
    }
  });

  return sites;
}

/**
 * Recover tool-definition literals regardless of how they are registered.
 *
 * The dominant real-world shape is a module holding tool definitions as data,
 * registered elsewhere by a loop or by a shared base package. No call site names
 * those tools, so the registration scan cannot see them.
 *
 * The match stays narrow, in two tiers. A static string `name` beside a
 * distinctive schema key qualifies on its own. A name beside a schema key that
 * is common outside MCP qualifies only with corroboration, because guessing
 * wider invents tools that do not exist and an invented tool becomes a phantom
 * removal in the next release.
 *
 * The tiers are measured rather than assumed: both keys below the distinctive
 * line are present in pinned corpus artifacts, and `parameters` is the one that
 * an OpenAI-style function descriptor shares.
 */
function collectToolDefinitions(program: AstNode, context: FileContext, definitions: Map<string, BuiltTool>): void {
  walk(program, (node) => {
    if (node.type !== "ObjectExpression") return;
    const name = stringLiteralValue(propertyValue(node, "name"));
    if (name === undefined || definitions.has(name)) return;

    let schema = firstProperty(node, DISTINCTIVE_SCHEMA_KEYS);
    if (!schema) {
      const ambiguous = firstProperty(node, CORROBORATED_SCHEMA_KEYS);
      if (!ambiguous) return;
      if (!TOOL_CORROBORATION.some((key) => propertyValue(node, key))) return;
      schema = ambiguous;
    }

    definitions.set(name, buildTool(
      name,
      propertyValue(node, "description"),
      schema,
      context,
      [node.start, node.end],
      "definition"
    ));
  });
}

/**
 * True for `<anything>.experimental.tasks.registerToolTask`.
 *
 * The receiver itself is not checked. Establishing that it is an SDK server
 * needs import lineage, which bundling erases — gating on it now would refuse
 * the one real artifact this recognises. The cost is a known precision debt: an
 * unrelated object with that exact three-segment path would be accepted.
 */
function onTaskRegistrationPath(callee: AstNode): boolean {
  let node = callee.object as AstNode | undefined;
  for (const segment of TASK_REGISTRATION_PATH) {
    if (!node || node.type !== "MemberExpression" || memberName(node) !== segment) return false;
    node = node.object as AstNode | undefined;
  }
  return node !== undefined;
}

function firstProperty(object: AstNode, keys: string[]): AstNode | undefined {
  for (const key of keys) {
    const value = propertyValue(object, key);
    if (value) return value;
  }
  return undefined;
}

/** `server.tool("name", ...)` and `server.registerTool("name", { ... }, handler)`. */
function collectRegistrationCall(
  method: string,
  call: AstNode,
  args: AstNode[],
  context: FileContext,
  tools: Map<string, ExtractedTool>,
  incompleteness: Set<string>,
  agentText: AgentTextSpan[]
): void {
  const name = stringLiteralValue(args[0]);
  if (name === undefined) {
    // A real registration whose name is computed, most often a loop over tool
    // definitions held as data. The tool exists; this extractor cannot name it.
    // Recording the gap is what stops the inventory from looking authoritative.
    incompleteness.add("registration_name_not_static");
    return;
  }

  const range: [number, number] = [call.start, call.end];
  if (CONFIG_STYLE_REGISTRATIONS.has(method)) {
    const config = args[1];
    if (config?.type === "ObjectExpression") {
      const description = propertyValue(config, "description");
      const inputSchema = propertyValue(config, "inputSchema");
      addTool(tools, buildTool(name, description, inputSchema, context, range, "registration"), agentText);
      return;
    }
    addTool(tools, buildTool(name, undefined, undefined, context, range, "registration"), agentText);
    return;
  }

  // `tool(name, description?, paramsSchema?, annotations?, handler)` is overloaded.
  // Take the first trailing string literal as the description and the first
  // object literal as the parameter schema.
  const rest = args.slice(1);
  const description = rest.find((argument) => argument.type === "Literal" && typeof argument.value === "string");
  const inputSchema = rest.find((argument) => argument.type === "ObjectExpression");
  addTool(tools, buildTool(name, description, inputSchema, context, range, "registration"), agentText);
}

/** `server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [ ... ] }))`. */
function collectListToolsHandler(
  handler: AstNode | undefined,
  context: FileContext,
  moduleConstants: Map<string, AstNode>,
  tools: Map<string, ExtractedTool>,
  incompleteness: Set<string>,
  agentText: AgentTextSpan[]
): void {
  if (!handler) {
    incompleteness.add("list_tools_handler_not_static");
    return;
  }

  let toolsValue: AstNode | undefined;
  walk(handler, (node) => {
    if (node.type !== "ObjectExpression") return;
    const candidate = propertyValue(node, "tools");
    if (candidate && !toolsValue) toolsValue = candidate;
  });

  if (!toolsValue) {
    incompleteness.add("list_tools_handler_not_static");
    return;
  }

  const array = resolveArray(toolsValue, moduleConstants);
  if (!array) {
    incompleteness.add("list_tools_array_not_static");
    return;
  }

  for (const element of (array.elements as Array<AstNode | null> | undefined) ?? []) {
    if (!element) continue;
    if (element.type === "SpreadElement") {
      incompleteness.add("list_tools_array_uses_spread");
      continue;
    }
    if (element.type !== "ObjectExpression") {
      incompleteness.add("list_tools_entry_not_static");
      continue;
    }
    const name = stringLiteralValue(propertyValue(element, "name"));
    if (name === undefined) {
      incompleteness.add("list_tools_entry_name_not_static");
      continue;
    }
    addTool(tools, buildTool(
      name,
      propertyValue(element, "description"),
      propertyValue(element, "inputSchema"),
      context,
      [element.start, element.end],
      "registration"
    ), agentText);
  }
}

function buildTool(
  name: string,
  description: AstNode | undefined,
  inputSchema: AstNode | undefined,
  context: FileContext,
  charRange: [number, number],
  discovery: ExtractedTool["discovery"]
): BuiltTool {
  const { source, artifactPath, fileSha256 } = context;
  const spans: AgentTextSpan[] = [];
  const tool: ExtractedTool = {
    name,
    discovery,
    artifact_path: artifactPath,
    byte_range: toByteRange(source, charRange[0], charRange[1])
  };

  // The tool name reaches the model verbatim, so it is rule-visible text too.
  spans.push({
    kind: "tool_name",
    toolName: name,
    text: name,
    artifactPath,
    fileSha256,
    byteRange: tool.byte_range
  });

  if (description) {
    const literal = stringLiteralValue(description);
    if (literal === undefined) {
      tool.description_sha256 = sha256(normalizeSource(source, description));
      tool.description_repr = "source_text";
    } else {
      tool.description_sha256 = sha256(literal);
      tool.description_repr = "string_literal";
      spans.push({
        kind: "tool_description",
        toolName: name,
        text: literal,
        artifactPath,
        fileSha256,
        byteRange: toByteRange(source, description.start, description.end)
      });
    }
  }

  if (inputSchema) {
    const json = staticJsonValue(inputSchema);
    if (json === undefined) {
      tool.input_schema_sha256 = sha256(normalizeSource(source, inputSchema));
      tool.input_schema_repr = "source_text";
      if (inputSchema.type === "ObjectExpression") {
        const keys = literalPropertyNames(inputSchema);
        if (keys) tool.input_schema_properties = keys;
      }
    } else {
      tool.input_schema_sha256 = sha256(canonicalJson(json));
      tool.input_schema_repr = "json_literal";
      const properties = isRecord(json) && isRecord(json.properties) ? json.properties : isRecord(json) ? json : undefined;
      if (properties) tool.input_schema_properties = Object.keys(properties).sort();
    }
  }

  return { tool, spans };
}

/**
 * The first registration of a name wins. Files are scanned in sorted path order
 * so the choice is deterministic across runs of the same artifact.
 *
 * Text spans are only collected for a tool that is actually recorded, so a name
 * seen twice cannot raise the same finding twice.
 */
function addTool(tools: Map<string, ExtractedTool>, built: BuiltTool, agentText: AgentTextSpan[]): void {
  if (tools.has(built.tool.name)) return;
  tools.set(built.tool.name, built.tool);
  agentText.push(...built.spans);
}

/** Module-scope `const x = [ ... ]` bindings, used to resolve a `tools: TOOLS` reference. */
function moduleScopeArrays(program: AstNode): Map<string, AstNode> {
  const constants = new Map<string, AstNode>();
  for (const statement of (program.body as AstNode[] | undefined) ?? []) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration as AstNode | undefined
      : statement;
    if (!declaration || declaration.type !== "VariableDeclaration") continue;
    for (const declarator of (declaration.declarations as AstNode[] | undefined) ?? []) {
      const id = declarator.id as AstNode | undefined;
      const init = declarator.init as AstNode | undefined;
      if (id?.type === "Identifier" && typeof id.name === "string" && init?.type === "ArrayExpression") {
        constants.set(id.name, init);
      }
    }
  }
  return constants;
}

function resolveArray(node: AstNode, moduleConstants: Map<string, AstNode>): AstNode | undefined {
  if (node.type === "ArrayExpression") return node;
  if (node.type === "Identifier" && typeof node.name === "string") return moduleConstants.get(node.name);
  return undefined;
}

/** True when the first `setRequestHandler` argument names the ListTools schema. */
function mentionsListTools(node: AstNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return node.name === "ListToolsRequestSchema";
  if (node.type === "MemberExpression") return memberName(node) === "ListToolsRequestSchema";
  return false;
}

function memberName(member: AstNode): string | undefined {
  const property = member.property as AstNode | undefined;
  if (!property) return undefined;
  if (member.computed) return stringLiteralValue(property);
  return property.type === "Identifier" && typeof property.name === "string" ? property.name : undefined;
}

function propertyValue(object: AstNode, key: string): AstNode | undefined {
  for (const property of (object.properties as AstNode[] | undefined) ?? []) {
    if (property.type !== "Property") continue;
    if (propertyKey(property) === key) return property.value as AstNode | undefined;
  }
  return undefined;
}

function propertyKey(property: AstNode): string | undefined {
  const key = property.key as AstNode | undefined;
  if (!key) return undefined;
  if (property.computed) return stringLiteralValue(key);
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  return stringLiteralValue(key);
}

function literalPropertyNames(object: AstNode): string[] | undefined {
  const names: string[] = [];
  for (const property of (object.properties as AstNode[] | undefined) ?? []) {
    if (property.type !== "Property") return undefined;
    const key = propertyKey(property);
    if (key === undefined) return undefined;
    names.push(key);
  }
  return names.sort();
}

function stringLiteralValue(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  // A template literal with no substitutions is still a static string.
  if (node.type === "TemplateLiteral") {
    const expressions = (node.expressions as unknown[] | undefined) ?? [];
    const quasis = (node.quasis as AstNode[] | undefined) ?? [];
    if (expressions.length === 0 && quasis.length === 1) {
      const cooked = (quasis[0]?.value as { cooked?: unknown } | undefined)?.cooked;
      if (typeof cooked === "string") return cooked;
    }
  }
  return undefined;
}

/** Convert a fully static literal expression to a JSON value, or undefined. */
function staticJsonValue(node: AstNode): unknown {
  switch (node.type) {
    case "Literal": {
      const value = node.value;
      if (value === null) return null;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
      return undefined;
    }
    case "TemplateLiteral":
      return stringLiteralValue(node);
    case "UnaryExpression": {
      if (node.operator !== "-") return undefined;
      const argument = staticJsonValue(node.argument as AstNode);
      return typeof argument === "number" ? -argument : undefined;
    }
    case "ArrayExpression": {
      const result: unknown[] = [];
      for (const element of (node.elements as Array<AstNode | null> | undefined) ?? []) {
        if (!element) return undefined;
        const value = staticJsonValue(element);
        if (value === undefined) return undefined;
        result.push(value);
      }
      return result;
    }
    case "ObjectExpression": {
      const result: Record<string, unknown> = {};
      for (const property of (node.properties as AstNode[] | undefined) ?? []) {
        if (property.type !== "Property") return undefined;
        const key = propertyKey(property);
        if (key === undefined) return undefined;
        const value = staticJsonValue(property.value as AstNode);
        if (value === undefined) return undefined;
        result[key] = value;
      }
      return result;
    }
    default:
      return undefined;
  }
}

/** Deterministic JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Whitespace-normalized source slice. Used when an expression is not a static
 * literal: the hash still detects any edit, but cannot describe the edit.
 */
function normalizeSource(source: string, node: AstNode): string {
  return source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) walk(item, visit);
      }
    } else if (isAstNode(value)) {
      walk(value, visit);
    }
  }
}

function isAstNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return typeof value === "string"
    ? createHash("sha256").update(value, "utf8").digest("hex")
    : createHash("sha256").update(value).digest("hex");
}
