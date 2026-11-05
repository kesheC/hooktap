# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `verify` treats a stored `raw` of `null` as "payload not stored" and falls back to the decoded body, matching replay semantics (it used to hash the string `"null"`).
- `verify` reports malformed captures (a `null` entry or a record without object `headers`) as a clean exit-2 error instead of an uncaught `TypeError`.
- Unknown `--*` options are rejected with exit 2 instead of being silently ignored, and value flags followed by another flag (or no value at all) are usage errors.
- `replayCapture` rejects its promise for invalid arguments instead of throwing synchronously, and refuses non-http(s) target schemes with a clear error.
- `listen --host` with an IPv6 address now prints a parseable URL (`http://[::1]:PORT`).
- Broken-pipe guard: a closed reader on stdout/stderr no longer crashes the CLI.

## [0.1.2] - 2026-11-05

### Fixed

- The `hooktap` bin ships with a shebang, so global installs work on Unix (the `dist/cli.js` entry was being executed as a shell script).

## [0.1.1] - 2026-11-05

### Fixed

- Signature verification looks up header names case-insensitively, so `X-Hub-Signature-256` verifies.
- Capture persistence is atomic and reports write failures on stderr.
- Bodyless replays (GET/HEAD) no longer declare a content-length they never send.
- Replays enforce an absolute timeout and strip hop-by-hop response headers.
- The capture server enforces a request size limit (413) and reports listen errors with exit code 2.
- `verify` validates the store's format version through the same loader as `listen`.
- Coverage floors (80/70/85/80) are enforced via `vitest.config.ts`, and the UTF-8 payload fidelity limit is documented.

## [0.1.0] - 2026-11-05

### Added

- Initial release: local webhook capture with raw-byte fidelity, HMAC signature verification, and replay to any target.
