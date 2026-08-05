# MCP specification snapshot — provenance

Sentinel's analysis is pinned to a specific revision of the Model Context Protocol
specification. The specification text itself is **not redistributed here**: it is
third-party content under its own upstream licence.

This manifest records exactly which snapshot the pinned protocol profile in
[PROTOCOL_PROFILE_2026-07-28.md](PROTOCOL_PROFILE_2026-07-28.md) was derived from,
so the derivation stays reproducible and auditable without republishing someone
else's document.

| Field | Value |
| --- | --- |
| Specification revision | `2026-07-28` |
| Snapshot retrieved | `2026-08-01` |
| Upstream index | <https://modelcontextprotocol.io/llms.txt> |
| Project home | <https://modelcontextprotocol.io> |

## Snapshot digests

SHA-256 of each retrieved document, as captured on the retrieval date above.

| Document | Bytes | SHA-256 |
| --- | ---: | --- |
| `MCP_spec_2026-08-01_general.md` | 5959 | `40648eb20d6050d35f689106dd2abc2ad56d9e9cf9439acf832b84a3e304a669` |
| `MCP_spec_2026-08-01_prompts.md` | 10375 | `a2042be7a53bb1a0e5afd322438b5d99397190e937fe8cb523b83f7fefee1b29` |
| `MCP_spec_2026-08-01_resources.md` | 13982 | `802ea460328b2167b033514c677ac6483aabb7bdc5edea48ad447c4931637d12` |
| `MCP_spec_2026-08-01_tools.md` | 25111 | `b62cbff3c867343f3b2409ea2cda4167faf0d88eb3aa14ca1d1188e052ec673f` |

## Verifying a local copy

The snapshot files are excluded from version control. To reconstruct and verify a
working copy, place the retrieved documents in `docs/MCP-specs-2026-07-28/` and
check them against this manifest:

```sh
cd docs/MCP-specs-2026-07-28
sha256sum -c ../SPEC_PROVENANCE.sha256
```

A digest mismatch means the upstream document changed after the snapshot date. That
is a signal to review the protocol profile, **not** to silently update this file:
the pinned revision is part of the analyzer's contract, and changing it changes what
reports mean.
