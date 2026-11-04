# Contributing to hooktap

Thanks for wanting to help. `hooktap` is a small tool that does one thing: turn a
conventional-commit log into a decided, gated, frozen release - plan, gates, freeze, tag,
pack - without a registry dependency.

## Before you start

- **Bugs and feature ideas go to [Issues](https://github.com/kesheC/hooktap/issues)**, using
  the templates there. Include the exact command and its complete output; a screenshot of a
  terminal is not reproducible.
- **Security problems never go to a public issue.** Use the private channel in
  [SECURITY.md](https://github.com/kesheC/hooktap/blob/main/SECURITY.md).
- For anything larger than a typo, open an issue first and describe the problem you are trying
  to solve. A pull request that arrives before the problem is agreed on is hard to accept,
  however good the code is.

## Setting up

You need Node.js 20.11 or newer. There is nothing to install beyond dev dependencies:

> The shipped CLI runs on Node 20.11. The **test runner is newer than the runtime floor**:
> vitest 4 pulls in vite 8, which declares `^20.19.0 || >=22.12.0`. On Node 20.11-20.18 the
> tool still runs, but `npm test` does not - use a current 20.x, 22.x or 24.x to work on it.
> CI's `node: 20` column resolves to the latest 20.x, so it is above that line.

```bash
git clone https://github.com/kesheC/hooktap.git
cd hooktap
npm ci
npm run build
node dist/cli.js --help
```

`dist/` is what the published tarball ships, so `npm run build` has to succeed for anything to
be reviewable. `node dist/cli.js` runs the build you just made; a `hooktap` on your PATH is
whatever release you installed earlier and is usually stale.

## The quality gates

Every change has to pass the commands CI runs:

```bash
npm run typecheck   # tsc --noEmit, tests included
npm run build       # tsc -p tsconfig.build.json
npm test            # vitest run
npm run coverage    # the same suite under v8, which fails below the floors
npm audit --audit-level=high   # the toolchain is the entire supply chain
```

Opening the pull request runs them on Ubuntu and Windows across Node 20, 22 and 24. Coverage is
the exception: it is a second full run of the suite, so it takes one leg instead of six - Linux
on Node 24, the same one every time, so the numbers stay comparable.

The floors live in `vitest.config.ts` under `coverage.thresholds` and are deliberately a little
below what the suite reaches today. They are there to catch a real regression, not to make an
unrelated change pay for a rounding error: if a change drops coverage under a floor, the honest
responses are to test the new branch or to lower the floor in the same pull request with a
reason, not to delete the assertion.

The audit is part of the gate because this package ships no runtime dependencies: what you
install to work on it *is* the whole supply chain. It fails on high and critical advisories
only; a moderate finding is worth reading when you next touch the dependencies, but it is not
worth blocking an unrelated fix.

## The README transcripts are executable

Every command transcript in README.md is verified against the real CLI before it is committed,
and the guard tests re-verify the example blocks that CI can run. If your change alters CLI
output, the transcripts change with it, in the same pull request. A README that shows output
the code does not produce is treated as a bug, not documentation drift.

## Release policy

`hooktap` releases itself: freeze the changelog, run the gates, tag, pack. A maintainer
runs `node dist/cli.js release`, pushes the tag, and the Release workflow attaches the tarball
and its checksum. Do not bump versions by hand in a pull request; the bump is decided from the
commit log at release time.