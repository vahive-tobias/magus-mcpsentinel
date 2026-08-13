# `firecrawl-mcp` 3.23.6 → 3.24.0

Analyzed 2026-08-13 with `magus-mcpsentinel@0.2.0`. Both artifacts passed the
registry's `dist.integrity` check. **Zero findings** on either version.

| | |
| --- | --- |
| Baseline | `3.23.6`, SHA-256 `d7fe72518707a9f9be0e3c396b4aaefe7f301d3220c356e730cde0c31b38c423` |
| Candidate | `3.24.0`, SHA-256 `34e8f48139a9f445c40046253bf3dd240344b6465b1845dc275b59ae23cbcb2c` |
| Tool surface | 27 tools recovered either side, **incomplete on both** |
| Conclusions withheld | yes — see below |

Seven changes, and this is the report where the tool's limits are visible. Read
the withheld conclusion first, because it bounds everything after it.

## What could not be established

```
[comparison_limited] The new report's tool inventory is a lower bound:
                     some sources could not be statically resolved.
```

Twenty-seven tools were recovered from each version, but the extractor could not
prove that is all of them. Two reasons are recorded, on both versions:

- `no_recognized_registration_pattern` — no registration shape this extractor
  knows was found in at least one candidate source file.
- `tools_inferred_from_definitions_only` — some tools are known from definition
  objects rather than from a proven registration call site.

**So this report cannot tell you that no tool was added or removed.** It can tell
you about the twenty-seven it can see, and it does. A tool missing from an
incomplete extraction is never reported as removed — that rule is what keeps the
absence of an alarm from being mistaken for evidence of absence.

The limitation is ours, not the package's. Recovering a surface by parsing shipped
JavaScript reaches what it reaches, and this package builds part of its tool list
in a shape the extractor does not follow.

## Two tool descriptions were rewritten

```
[tool_description_changed] Tool firecrawl_research_search_papers description changed.
[tool_description_changed] Tool firecrawl_search description changed.
```

A tool description is not documentation. It is text the model reads and acts on
when deciding whether and how to call the tool, which makes it part of the agent's
instruction surface. Both tools keep their names and their input schemas — only
the text a model reads changed.

Sentinel records that the description digest moved. It does not diff the prose,
and it does not judge it.

## A file was added to the shipped surface

```
[file_inventory_changed] 1 added, 0 removed
                         + package/dist/www-authenticate.js
```

One new file ships in the package that was not in the approved version. Its name
suggests HTTP authentication header handling; Sentinel does not read it and offers
no interpretation beyond the fact that it is present and was not before.

This is the class of change the inventory exists to surface: a file appearing in a
package's shipped output is not visible from a version number, a changelog, or a
lockfile entry.

## Everything else

```
[metadata_changed]     Package "description" changed.
[file_content_changed] 3 files changed contents
                       package/README.md
                       package/dist/index.js
                       package/package.json
```

## Reproduce

```sh
npx magus-mcpsentinel analyze npm firecrawl-mcp@3.23.6 --evidence-dir ./ev --output a.json
npx magus-mcpsentinel analyze npm firecrawl-mcp@3.24.0 --evidence-dir ./ev --output b.json
npx magus-mcpsentinel diff a.json b.json
```

The diff exits with a note that conclusions were withheld. That is the correct
outcome for this pair, not a failure of the run.
