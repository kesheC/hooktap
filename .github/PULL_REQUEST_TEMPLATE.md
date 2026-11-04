## Why

<!-- The problem this solves, in a sentence or two. Link the issue if there is one. -->

## What changed

<!-- Bullet the actual changes. "Refactor" and "cleanup" are not changes. -->

## Evidence

<!--
The commands you ran and what they printed. A behaviour change needs output that shows the new
behaviour; "tests pass" only shows that nothing you already had broke.
-->

```console
$ hooktap --version
```

## Checklist

- [ ] `npm run typecheck`, `npm run build` and `npm test` all pass locally.
- [ ] A test fails without this change and passes with it.
- [ ] No new runtime dependency (`dependencies` in `package.json` stays empty).
- [ ] Printed output still goes to the right stream: machine output on stdout, human notes on stderr.
- [ ] If the README quotes a transcript this change touches, the transcript was re-run and updated.
- [ ] No version bump and no `CHANGELOG.md` edit — releases are cut separately.