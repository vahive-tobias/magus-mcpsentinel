# Sentinel Protocol Profile: MCP 2026-07-28

## Purpose

This is the protocol contract for Sentinel Core. It is based on the MCP
specification released on `2026-07-28`, retrieved from modelcontextprotocol.io on
`2026-08-01`.

The specification text is third-party content and is **not redistributed in this
repository**. [SPEC_PROVENANCE.md](SPEC_PROVENANCE.md) records the source, the
retrieval date, and the SHA-256 of each document, so the derivation below stays
reproducible and verifiable against a re-fetched copy.

The directory name identifies the MCP specification revision; the file names
identify the local retrieval date, not a second specification release. Sentinel
records both values in report provenance. This profile is intentionally a
versioned document: a later MCP revision requires a new profile and fixture
compatibility review.

## Rules Sentinel must honor

| MCP behavior | Sentinel requirement |
| --- | --- |
| Tools, resources, and prompts are capability-gated and listed through `*/list` | Preserve declared capabilities and record every discovery request/response. Do not infer support merely from source code. |
| All three list methods support pagination | Follow every `nextCursor`, impose a documented page/time ceiling, and mark coverage incomplete on a ceiling or error. |
| Lists can vary by authorization, but not connection state or request side effects | Tag each inventory with an authorization profile. Never describe an anonymous inventory as the complete server surface. |
| `listChanged` is optional | Save the declared feature and any observed notification. An observation window is evidence of notifications received, not proof of stability. |
| A tool has required `inputSchema`, optional `outputSchema`, and optional annotations | Canonicalize and hash both schemas and annotations; validate JSON Schema syntax against the specified default draft (2020-12 unless `$schema` says otherwise). |
| Tool annotations are untrusted unless the server is trusted | Store annotations as server-supplied claims; never use them to suppress a finding or assign trust. |
| `x-mcp-header` can mirror Streamable-HTTP parameters into request headers | On future HTTP support, validate constraints and report potential sensitive-data exposure. It is not relevant to stdio execution semantics. |
| Prompts and tool results may include text, image, audio, resource links, and embedded resources | Record type, MIME metadata, byte size, content digest, and evidence location. Do not silently discard non-text content. |
| Resources may use `file://` URIs and carry user/assistant audience annotations | Treat URIs and annotations as untrusted input. Record them without opening paths outside the sandbox. |
| The protocol recommends human consent for tool use and warns that tools represent arbitrary code execution | Core discovery must not invoke arbitrary tools. Any future active probing needs a per-tool safety policy and an explicit no-production-data guarantee. |

## Discovery coverage record

Every advertised inventory in a report uses this shape:

```json
{
  "kind": "tools",
  "protocol_profile": "mcp-2026-07-28",
  "authorization_profile": "none",
  "capability_declared": true,
  "pages_completed": 2,
  "complete": true,
  "started_at": "2026-08-02T12:00:00Z",
  "ended_at": "2026-08-02T12:00:01Z",
  "list_changed_declared": true,
  "list_changed_notifications_observed": 0,
  "items_sha256": "..."
}
```

`complete: true` means all list pages were returned under the recorded profile.
It does **not** mean that the list is exhaustive for every credential scope,
time, server configuration, or runtime environment.

## Analyzer acceptance tests

The fixture suite must prove that Sentinel:

1. collects multi-page lists without duplicates or cursor loops;
2. preserves a separate inventory for each explicitly configured authorization
   profile, without ever persisting an authorization secret;
3. records notification observations without treating lack of a notification as
   a stability guarantee;
4. retains `inputSchema`, `outputSchema`, annotations, and content-type metadata
   in canonical form;
5. refuses to dereference `file://` or remote resource links during passive
   discovery; and
6. never sends `tools/call` during its default discovery workflow.

## Source map

- `MCP_spec_2026-08-01_general.md` — security and trust-and-safety principles.
- `MCP_spec_2026-08-01_tools.md` — tool discovery, pagination, schemas,
  `x-mcp-header`, stateful-tool guidance, and security considerations.
- `MCP_spec_2026-08-01_resources.md` — resource discovery, subscriptions,
  annotations, URI handling, and security considerations.
- `MCP_spec_2026-08-01_prompts.md` — prompt discovery, authorization-sensitive
  lists, multimodal content, and input/output validation expectations.
