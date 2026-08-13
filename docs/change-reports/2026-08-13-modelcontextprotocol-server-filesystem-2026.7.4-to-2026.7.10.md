# `@modelcontextprotocol/server-filesystem` 2026.7.4 → 2026.7.10

Analyzed 2026-08-13 with `magus-mcpsentinel@0.2.0`. Both artifacts passed the
registry's `dist.integrity` check. **Zero findings** on either version.

| | |
| --- | --- |
| Baseline | `2026.7.4`, SHA-256 `7ced44bb52a64349e12217a8d90d349b9d941a0560b3f0e3df05aeee8ed4da54` |
| Candidate | `2026.7.10`, SHA-256 `c17c1da371c8089cff2206cce3001194d8276bae2b5ac1e2b425b6612068e3ba` |
| Tool surface | 14 tools either side, **statically complete on both** |
| Conclusions withheld | none |

Three changes. **This report is included because it is unremarkable, and most
releases are.**

A page of reports selected for interest would misrepresent what using this tool is
like. The honest ratio matters: if every notice carried something worth acting on,
the tool would be describing a catastrophe rather than a software ecosystem.

## One tool description changed

```
[tool_description_changed] Tool read_media_file description changed.
```

Fourteen tools, statically complete on both versions, so this is a full comparison
rather than a lower bound: **no tool was added or removed, and no input schema
changed.** One tool's description text — which a model reads when deciding how to
call it — was edited.

That is the entire agent-facing change in this release.

## Everything else

```
[file_content_changed] 3 files changed contents
                       package/README.md
                       package/dist/index.js
                       package/package.json
```

No dependencies changed. No files were added or removed. No entrypoint or install
script moved.

## Why publish this one

Two of the four reports in this set had to withhold a conclusion because the tool
surface could not be fully resolved. This one did not, and the difference is worth
seeing side by side: when extraction is complete, "no tool was added or removed"
is a statement the evidence supports. When it is not, the report says so instead
of implying it.

A reader deciding whether to trust this tool should be able to see both cases, and
should see that the ordinary release looks ordinary.

## Reproduce

```sh
npx magus-mcpsentinel analyze npm @modelcontextprotocol/server-filesystem@2026.7.4 --evidence-dir ./ev --output a.json
npx magus-mcpsentinel analyze npm @modelcontextprotocol/server-filesystem@2026.7.10 --evidence-dir ./ev --output b.json
npx magus-mcpsentinel diff a.json b.json
```
