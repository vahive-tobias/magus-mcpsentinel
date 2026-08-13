# `@upstash/context7-mcp` 3.2.5 → 4.0.0

Analyzed 2026-08-13 with `magus-mcpsentinel@0.2.0`. Both artifacts passed the
registry's `dist.integrity` check. **Zero findings** on either version.

| | |
| --- | --- |
| Baseline | `3.2.5`, SHA-256 `eb801dc8b6f29b315481f131fbf5258a99292fbf3325b0ef2ca2a5ac524c93cb` |
| Candidate | `4.0.0`, SHA-256 `08118a6721df34594b804c0de6b8e6e039a8d9e3eff16e301955887aec57d66f` |
| Tool surface | 2 tools either side, **statically complete on both** |
| Conclusions withheld | none |

Nine changes. This is the clearest of the four reports because nothing had to be
withheld: the extractor resolved the whole tool surface on both versions, so every
statement below is a comparison between two complete pictures.

## The runtime dependency set was replaced, not adjusted

```
+ @modelcontextprotocol/node@2.0.0
+ @modelcontextprotocol/server@2.0.0
- @modelcontextprotocol/sdk@^1.29.0
- @upstash/redis@^1.38.0
```

The single `sdk` dependency becomes two packages at a new major version, and the
Redis client leaves entirely. Consistent with the two files that disappeared:

```
- package/dist/lib/redis.js
- package/dist/lib/sessionStore.js
```

A published major version is the appropriate place for this, and the version
number says so. It is recorded here because "what my agent will load has changed"
is exactly the question a lockfile answers for direct dependencies and does not
answer for a server's own internals.

## Both tools kept their names and changed their input schemas

```
[tool_schema_changed] Tool query-docs input schema changed.
[tool_schema_changed] Tool resolve-library-id input schema changed.
```

**Neither schema gained a new input field.** The detail records
`addedProperties: []` for both, meaning the schema digest moved without the tool
accepting anything it previously refused. That distinction matters: a widened
schema accepts input the approved version would have rejected, and this is not
that. What the change *is* — a type narrowed, a description moved, a constraint
altered — is beyond what a digest can say, and the report does not guess.

The tool *names* are unchanged, so an agent's prompt surface keeps the same two
entry points across the upgrade.

## Everything else

```
[file_inventory_changed] 0 added, 2 removed        (the two files above)
[file_content_changed]   5 files changed contents
                         package/README.md
                         package/dist/index.js
                         package/dist/lib/auth/auth-prompt.js
                         package/dist/lib/utils.js
                         package/package.json
```

`auth-prompt.js` changing alongside a dependency replacement is worth a reader's
attention on an authentication path, which is the whole reason the files are named
rather than counted. Sentinel does not read what changed inside them and offers no
opinion on it.

## Reproduce

```sh
npx magus-mcpsentinel analyze npm @upstash/context7-mcp@3.2.5 --evidence-dir ./ev --output a.json
npx magus-mcpsentinel analyze npm @upstash/context7-mcp@4.0.0 --evidence-dir ./ev --output b.json
npx magus-mcpsentinel diff a.json b.json
```
