#!/usr/bin/env node
/**
 * Measure static tool-extraction coverage across the pinned corpus.
 *
 *   node scripts/measure-coverage.mjs [--refetch] [--accept-drift]
 *
 * Reads `corpus/packages.txt`, analyzes each artifact through the shipped CLI,
 * and writes `corpus/metrics.json`. Nothing improves reliably until it is
 * measured the same way every time, and the figure this produces is the first
 * reproducible one this project has had — the corpus behind the published 32%
 * was never checked in.
 *
 * It spawns the CLI rather than importing the analyzer, so what gets measured is
 * the path a user actually runs, including acquisition and integrity checking.
 *
 * Artifacts are cached under `corpus/.cache/`, which is gitignored: committing
 * third-party tarballs to a public repository raises licensing, size and
 * malware-handling questions that a digest in a lock file does not.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// The contract's own identifiers, not substring guesses. `id.includes('tool')`
// reads the right observation today and would silently read the wrong one the
// day an observation is named with an overlapping word.
import { OBSERVATION_IDS } from 'magus-mcpsentinel/report-contract';
// Path-shape exclusion is an approximation, not proof that a file is irrelevant
// at runtime. Recording what it skipped keeps that inspectable in the corpus
// before any of it reaches the report contract.
import { isOutsideToolSurface } from 'magus-mcpsentinel/analyze';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = join(root, 'corpus');
const cache = join(corpus, '.cache');
const cli = join(root, 'packages', 'sentinel', 'dist', 'src', 'cli.js');

/**
 * Re-baseline against artifacts that changed under a pinned version.
 *
 * Without it, drift stops the run and nothing is written. That is the right
 * default: a fixed version serving different bytes is the event this project
 * exists to notice, and it must never be absorbed silently. Accepting it is a
 * deliberate act, and the accepted transition stays in `metrics.json` afterwards
 * so the re-baselining is auditable rather than invisible.
 *
 * It does not relax anything else. A package that could not be analyzed still
 * blocks the write, because that is a gap in the measurement rather than a
 * decision about an artifact.
 */
const acceptDrift = process.argv.includes('--accept-drift');

/**
 * Fetch every artifact again instead of reusing the locked one.
 *
 * The default reuses a cached tarball whose digest matches the lock, because the
 * common case is re-measuring after an extractor change and the artifacts cannot
 * have moved: the lock says which bytes they were. Fifty registry downloads to
 * re-read fifty files already on disk is slow and impolite, and it was the actual
 * cost of iterating today.
 *
 * The trade is explicit and recorded: a cached run cannot notice that npm has
 * republished a pinned version, so `metrics.json` carries `drift_checked: false`
 * and the scheduled CI job passes this flag.
 */
const refetch = process.argv.includes('--refetch');

/**
 * Accepted re-baselinings, appended and never rewritten.
 *
 * `metrics.json` describes one run, so anything recorded there is erased by the
 * next clean run — which is correct for a measurement and useless for an audit
 * trail. A decision to measure different bytes under a pinned version outlives
 * the run that made it, so it is kept in its own file.
 */
const DRIFT_HISTORY = 'accepted-drift.json';

/** Dependencies in this scope are SDK evidence, whatever the package is called. */
const SDK_SCOPE = '@modelcontextprotocol/';

async function readCorpus() {
  const text = await readFile(join(corpus, 'packages.txt'), 'utf8');
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

async function readLock() {
  const path = join(corpus, 'artifacts.lock.json');
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * What each package is, so the denominator is data rather than prose.
 *
 * Recovery only means something over packages that expose a tool surface at all.
 * `@crewhaus/mcp-host` is an MCP client, so its zero tools are correct and
 * counting it as a miss understates the extractor. An unclassified package is
 * `unknown` and stays out of the eligible subset rather than being assumed.
 */
async function readRoles() {
  const path = join(corpus, 'roles.json');
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, 'utf8'));
}

function observation(report, id) {
  return report.observations.find((item) => item.id === id);
}

/**
 * Everything the corpus records about one artifact.
 *
 * SDK evidence is captured and never acted on. It is informational until real
 * artifacts establish what it is worth: the extractor's own completeness stays
 * the safety gate, and a dependency name must not start deciding tool diffs.
 */
function measure(spec, report) {
  const inventory = observation(report, OBSERVATION_IDS.staticToolInventory);
  const files = observation(report, OBSERVATION_IDS.fileInventory);
  const deps = observation(report, OBSERVATION_IDS.runtimeDependencies);

  const tools = inventory?.data?.tools ?? [];
  const byDiscovery = { registration: 0, definition: 0 };
  for (const tool of tools) {
    if (tool.discovery === 'registration') byDiscovery.registration += 1;
    if (tool.discovery === 'definition') byDiscovery.definition += 1;
  }

  const declared = Object.entries(deps?.data?.dependencies ?? {})
    .filter(([name]) => name.startsWith(SDK_SCOPE))
    .map(([name, range]) => ({ name, range }));

  return {
    package: report.subject.artifact.package,
    version: report.subject.artifact.version,
    artifact_sha256: report.subject.artifact.sha256,
    spec,
    // Raw shape, not a verdict about it. An earlier version derived a
    // `likely_bundled` flag from a low entry count and the corpus disproved it
    // immediately: server-filesystem has seven entries because it is small.
    entries: files?.data?.entry_count ?? 0,
    regular_file_bytes: files?.data?.regular_file_bytes ?? 0,
    tools_total: tools.length,
    tools_by_discovery: byDiscovery,
    tool_names: tools.map((tool) => tool.name).sort(),
    // Where each recovered name came from. Without this a candidate that
    // disappears between runs cannot be shown to have come only from an excluded
    // path, and "the tools that vanished were false positives" stays an assertion.
    tool_sources: Object.fromEntries(
      tools.map((tool) => [tool.name, tool.artifact_path]).sort((a, b) => a[0].localeCompare(b[0]))
    ),
    inventory_recovered: tools.length > 0,
    // `complete` is Sentinel's own condition for permitting a removal
    // conclusion — extraction hit nothing it could not resolve. It is not
    // external ground truth that the package has no other tools.
    statically_complete: inventory?.data?.complete === true,
    incompleteness: inventory?.data?.incompleteness ?? [],
    scanned_files: (inventory?.data?.scanned_files ?? []).length,
    // What the tool-surface scan skipped on path shape alone. The file inventory
    // still records every one of these; only their claim on the tool surface was
    // dropped.
    excluded_from_tool_surface: (() => {
      const paths = (files?.data?.entries ?? [])
        .map((entry) => entry?.path)
        .filter((path) => typeof path === 'string' && isOutsideToolSurface(path));
      return { count: paths.length, sample: paths.slice(0, 8) };
    })(),
    sdk_evidence: {
      // `coverage: "declared"` in the report's own vocabulary: what package.json
      // says, not what the code was found to do.
      declared: declared.length > 0 ? declared : null,
      declared_present: declared.length > 0
    },
    // Which analyzer produced this row. A coverage figure is meaningless without
    // it: the next result must be attributable to a build, not just to a date.
    analyzer: {
      engine: report.analysis?.engine ?? null,
      protocol_profile: report.analysis?.protocol_profile?.id ?? null
    }
  };
}

/**
 * The cached tarball for a spec, if it is the one the lock names.
 *
 * The filename carries the digest, so this is a lookup rather than a hash: the
 * acquisition path already verified the bytes when it wrote the file, and the
 * lock is what says which bytes belong to this pinned version.
 */
async function lockedArtifact(spec, lock) {
  const digest = lock[spec];
  if (!digest) return undefined;
  const suffix = `-artifact-${digest}.tgz`;
  const found = (await readdir(cache)).find((name) => name.endsWith(suffix));
  return found ? join(cache, found) : undefined;
}

async function analyze(spec, lock) {
  const safe = spec.replace(/[@/]/g, '_');
  const output = join(cache, `${safe}.report.json`);
  const cached = refetch ? undefined : await lockedArtifact(spec, lock);

  // Analyzing the local artifact skips acquisition, so a `--refetch` run is what
  // exercises registry fetching and integrity verification end to end.
  const target = cached ? [cached] : ['npm', spec, '--evidence-dir', cache];

  await run('node', [cli, 'analyze', ...target, '--output', output], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024
  });
  return { report: JSON.parse(await readFile(output, 'utf8')), fromCache: Boolean(cached) };
}

async function main() {
  if (!existsSync(cli)) {
    console.error('Build first: the harness measures the shipped CLI, not the sources.');
    process.exit(1);
  }
  await mkdir(cache, { recursive: true });

  const specs = await readCorpus();
  const lock = await readLock();
  const roles = await readRoles();
  const results = [];
  const failures = [];
  const drifted = [];
  let cachedCount = 0;

  for (const spec of specs) {
    process.stderr.write(`  ${spec} … `);
    try {
      const { report, fromCache } = await analyze(spec, lock);
      const row = measure(spec, report);
      row.role = roles[spec]?.role ?? 'unknown';
      if (fromCache) cachedCount += 1;

      const known = lock[spec];
      // Only a fetched artifact can disagree with the lock. A cached one was
      // selected *by* that digest, so comparing it would be checking our own
      // filename against itself.
      if (!fromCache && known && known !== row.artifact_sha256) {
        drifted.push({ spec, locked: known, served: row.artifact_sha256, accepted: acceptDrift });
      }
      lock[spec] = acceptDrift ? row.artifact_sha256 : known ?? row.artifact_sha256;

      results.push(row);
      const state = row.statically_complete
        ? 'statically complete'
        : row.incompleteness.join('+') || 'incomplete';
      process.stderr.write(`${row.tools_total} tools, ${state}\n`);
    } catch (error) {
      // One unreachable package must not cost the whole measurement.
      failures.push({ spec, error: error.message.split('\n')[0] });
      process.stderr.write('FAILED\n');
    }
  }

  const reasons = {};
  for (const row of results) {
    for (const reason of row.incompleteness) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  const recovered = results.filter((row) => row.inventory_recovered).length;
  const complete = results.filter((row) => row.statically_complete).length;
  const metrics = {
    generated_at: new Date().toISOString(),
    analyzer: results[0]?.analyzer ?? null,
    corpus_size: specs.length,
    analyzed: results.length,
    failed: failures,
    artifact_drift: drifted,
    // A cached run reuses locked artifacts and therefore cannot notice that npm
    // republished a pinned version. Recorded so a figure is never read as
    // drift-verified when it was not.
    drift_checked: refetch,
    artifacts_from_cache: cachedCount,
    // Two figures, because they answer different questions. Recovery means at
    // least one tool was found. Statically complete means extraction resolved
    // everything it looked at, which is the condition that licenses a removal
    // conclusion. Reporting one of them as "coverage" is how the number misleads.
    inventories_recovered: recovered,
    recovery_rate: results.length > 0 ? Number((recovered / results.length).toFixed(4)) : 0,
    statically_complete_extractions: complete,
    statically_complete_rate: results.length > 0 ? Number((complete / results.length).toFixed(4)) : 0,
    /**
     * The same two figures over packages that expose a tool surface at all.
     *
     * A client has no tools to find, so counting it as a miss understates the
     * extractor; counting it as a hit would overstate it. Excluding it belongs
     * in the numbers rather than in a sentence underneath them, and `roles.json`
     * carries the evidence for every classification.
     */
    eligible: (() => {
      const servers = results.filter((row) => row.role === 'server');
      const recoveredServers = servers.filter((row) => row.inventory_recovered).length;
      const completeServers = servers.filter((row) => row.statically_complete).length;
      return {
        basis: 'classified-server subset: role === "server" in corpus/roles.json',
        packages: servers.length,
        excluded: results.filter((row) => row.role !== 'server').map((row) => ({ package: row.package, role: row.role })),
        inventories_recovered: recoveredServers,
        recovery_rate: servers.length > 0 ? Number((recoveredServers / servers.length).toFixed(4)) : 0,
        statically_complete_extractions: completeServers,
        statically_complete_rate: servers.length > 0 ? Number((completeServers / servers.length).toFixed(4)) : 0
      };
    })(),
    tools_recovered_total: results.reduce((sum, row) => sum + row.tools_total, 0),
    incompleteness_reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    sdk_declared_count: results.filter((row) => row.sdk_evidence.declared_present).length,
    /**
     * Precision is not measured and must not be reported as if it were. Zero
     * observed false positives comes from spot-checking names by hand, not from
     * ground truth. Phase 2's offline `tools/list` harness is what makes this a
     * number; until then any precision claim is an estimate.
     */
    precision: { measured: false, blocked_on: 'ground-truth corpus (PLAN_COVERAGE Phase 2)' },
    packages: results.sort((a, b) => a.package.localeCompare(b.package))
  };

  const eligible = metrics.eligible;
  console.log(`\nwhole corpus: ${recovered}/${results.length} recovered (${(metrics.recovery_rate * 100).toFixed(1)}%) · ${complete}/${results.length} statically complete`);
  console.log(`classified servers:  ${eligible.inventories_recovered}/${eligible.packages} recovered (${(eligible.recovery_rate * 100).toFixed(1)}%) · ${eligible.statically_complete_extractions}/${eligible.packages} statically complete`);
  if (eligible.excluded.length > 0) {
    console.log(`excluded: ${eligible.excluded.map((item) => `${item.package} (${item.role})`).join(', ')}`);
  }
  console.log(`${metrics.tools_recovered_total} tools recovered`);
  console.log(`SDK declared: ${metrics.sdk_declared_count}/${results.length}`);
  if (Object.keys(reasons).length > 0) {
    console.log('reasons: ' + Object.entries(metrics.incompleteness_reasons).map(([r, n]) => `${r} ${n}`).join(' · '));
  }

  /**
   * The baseline is replaced only by a run that measured the whole corpus and
   * verified every locked digest.
   *
   * A partial run writes a smaller denominator, and a smaller denominator moves
   * the percentage. Left to overwrite, an npm outage would silently restate the
   * published coverage figure — a measurement that changes because the network
   * had a bad afternoon is worse than no measurement.
   */
  const measuredEverything = results.length === specs.length;
  const driftBlocks = drifted.length > 0 && !acceptDrift;
  const clean = measuredEverything && failures.length === 0 && !driftBlocks;

  if (drifted.length > 0) {
    const verb = acceptDrift ? 'ACCEPTED' : 'ARTIFACT DRIFT';
    console.error(`\n${verb}: ${drifted.length} pinned version(s) served different bytes than the lock records.`);
    for (const item of drifted) console.error(`  ${item.spec}\n    locked ${item.locked}\n    served ${item.served}`);
    if (!acceptDrift) console.error('  Re-run with --accept-drift to re-baseline against these artifacts.');
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${specs.length} package(s) could not be analyzed:`);
    for (const item of failures) console.error(`  ${item.spec}: ${item.error}`);
  }

  if (!clean) {
    console.error('\nBaseline NOT updated. corpus/metrics.json and corpus/artifacts.lock.json are unchanged.');
    process.exitCode = 1;
    return;
  }

  // Written with the baseline rather than before it: an accepted transition that
  // never became a measurement is not a decision anyone acted on.
  if (acceptDrift && drifted.length > 0) {
    const path = join(corpus, DRIFT_HISTORY);
    const history = existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : [];
    for (const item of drifted) {
      history.push({
        accepted_at: metrics.generated_at,
        spec: item.spec,
        locked: item.locked,
        served: item.served,
        analyzer_build: metrics.analyzer?.engine?.build_sha256 ?? null
      });
    }
    await writeFile(path, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
    console.log(`Recorded ${drifted.length} accepted transition(s) in corpus/${DRIFT_HISTORY}.`);
  }

  await writeFile(join(corpus, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  await writeFile(join(corpus, 'artifacts.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.log('\nBaseline updated.');
}

await main();
