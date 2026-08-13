# `@transcend-io/mcp-server-docs` 0.3.10 → 0.3.16

Analyzed 2026-08-13 with `magus-mcpsentinel@0.2.0`. Both artifacts passed the
registry's `dist.integrity` check. **Zero findings** on either version.

| | |
| --- | --- |
| Baseline | `0.3.10`, SHA-256 `0653411e01f0aa49365f516452fd49aad7ede4238e3dd29a677a70da1a7835b9` |
| Candidate | `0.3.16`, SHA-256 `09e793cfaf16d06ae42d9b62f14501d9ff55e38fde809136b8f1464a33dc8942` |
| Tool surface | 2 tools recovered either side, **incomplete on both** |
| Conclusions withheld | yes — the tool surface is a lower bound |

Four changes across six releases. This report is included for a specific reason:
the interesting change is one line, and it is a line most upgrade workflows would
never show you.

## A dependency crossed a major version

```
[dependency_changed] @transcend-io/mcp-server-base: 0.13.0 → 1.3.0
```

The server's own runtime dependency moves from `0.13.0` to `1.3.0` — across a
`1.0.0` boundary, so by semantic-versioning convention the maintainers are
signalling breaking changes in that package.

Two things make this worth a report:

**It is pinned exactly, on both sides.** Not `^0.13.0`, which would have allowed
the same drift silently. The maintainers pin, so the change is a deliberate,
recorded decision rather than a resolution artifact.

**Your own lockfile does not describe it.** `@transcend-io/mcp-server-base` is a
transitive dependency of anyone installing the server. It is visible if you go
looking; nothing puts it in front of you when a version bumps from `0.3.10` to
`0.3.16`, and the six-release gap between them makes it easy to read as routine.

Sentinel makes no claim about what changed inside that dependency. It reports that
the server you approved now loads a different major version of it.

## What could not be established

```
[comparison_limited] The new report's tool inventory is a lower bound:
                     some sources could not be statically resolved.
```

Two tools were recovered from each version, and the extractor could not prove that
is all of them, for the same two reasons on both sides:
`no_recognized_registration_pattern` and `tools_inferred_from_definitions_only`.

**So this report cannot tell you the tool surface is unchanged.** It can say that
the two tools it can see are unchanged in name and schema, which is a narrower
claim and the only one the evidence supports.

## Everything else

```
[file_content_changed] 2 files changed contents
                       package/dist/cli.mjs
                       package/package.json
```

A single bundled entrypoint and the manifest. Consistent with a dependency bump
and a rebuild, and consistent with a great deal else — Sentinel does not read
inside `cli.mjs` and has no opinion on what moved in it.

## Reproduce

```sh
npx magus-mcpsentinel analyze npm @transcend-io/mcp-server-docs@0.3.10 --evidence-dir ./ev --output a.json
npx magus-mcpsentinel analyze npm @transcend-io/mcp-server-docs@0.3.16 --evidence-dir ./ev --output b.json
npx magus-mcpsentinel diff a.json b.json
```
