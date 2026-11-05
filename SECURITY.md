# Security Policy

## Supported versions

hooktap is pre-1.0. Only the latest published release receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting channel:
<https://github.com/kesheC/hooktap/security/advisories/new>

If that is unavailable, open a minimal issue that says only *"security report — please contact me"* and wait for a maintainer to reach out. Do not include reproduction details, payloads, or secrets in the issue itself.

### What to include

- Affected version (`hooktap --version`).
- The smallest input that shows the problem.
- What you expected versus what happened.
- Whether the issue lets an attacker read data, execute code, or only crash the process.

### What to expect

This is a small project maintained on a best-effort basis. You should get an acknowledgement within about two weeks. A fix or a written "won't fix" with reasoning follows once the report is reproduced.

## Scope

In scope:

- Bypasses of the safety guarantees documented in the README.
- Crashes or unbounded resource use triggered by hostile input files.
- Anything that makes the tool leak data it promises to hide or ignore.

Out of scope:

- Findings that need an already-compromised machine or a modified local build.
- Denial of service from inputs that are simply enormous and well formed.
- Issues in Node.js itself rather than in this package.