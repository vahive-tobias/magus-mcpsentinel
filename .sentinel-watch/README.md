# Sentinel Watch — the free, self-hosted option

This directory is a working monitor that costs nothing to run. It uses the same
analyzer and the same severity policy as the Cloudflare monitor in
[`packages/watch`](../packages/watch); what differs is where the state lives.

- `watchlist.json` — the packages you want watched.
- `baselines/` — one committed report per package: the version you approved.
- `notice.md` — regenerated on each run; the body of the review pull request.

**Git is the database.** A baseline is a file, its history is the report history,
and review is a pull request: merging accepts the new baseline, closing keeps the
one you already had. A release you have not accepted keeps being raised, so
ignoring one is a decision you make rather than something that happens by default.

## Use it

1. Fork this repository, or copy this directory and
   [`.github/workflows/watch.yml`](../.github/workflows/watch.yml) into your own.
2. Add package names to `watchlist.json`.
3. Enable Actions. The first run records baselines; later runs raise changes.

Run it anywhere Node runs, with no GitHub involved:

```sh
npm ci && npm run build
node scripts/watch-check.mjs
```

That is the whole program. A cron entry on any machine works as well as a hosted
scheduler, and the exit code is non-zero only when nothing could be checked.

## Honest limits

- **Scheduled workflows are disabled after 60 days without repository activity**
  on public repositories. Merging a baseline pull request counts as activity, but
  a watch list that never changes will eventually go quiet. Check that it is still
  running, or run it somewhere else.
- **Scheduled runs can be delayed or dropped** when GitHub is busy. This is not a
  real-time alert; it is a "you should look at this before you upgrade" alert.
- **Private repositories get 2,000 Actions minutes a month** on the Free plan. A
  run costs a couple of minutes, so six-hourly checks fit comfortably. Public
  repositories are unmetered.
- **Your watch list is public if your repository is.** It reveals which packages
  you depend on. Use a private repository if that matters.
