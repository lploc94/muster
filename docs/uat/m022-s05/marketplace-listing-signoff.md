# M022 S05 Marketplace Listing Sign-off

## Purpose

Record an explicit human judgement of marketplace listing credibility for the
icon, README, and CHANGELOG. Objective machine checks live in
`scripts/packaging-listing-credibility.mjs` (D071). This ledger is the thin
auditable human layer: verdicts are one of `PASS`, `FAIL`, or `AWAITING-HUMAN`,
with a named reviewer field. Autonomous execution records `AWAITING-HUMAN`
rather than fabricating a human PASS.

## Reviewer

- Name: AWAITING-HUMAN
- Date: AWAITING-HUMAN

## Items

### Icon

- Verdict: AWAITING-HUMAN
- Machine check: packaging-listing-credibility icon PNG IHDR ≥128×128
- Notes: Machine check passes on the tracked resources/icon.png. Human reviewer confirms visual marketplace credibility before release.

### README

- Verdict: AWAITING-HUMAN
- Machine check: packaging-listing-credibility required README sections (Features, Prerequisites, Documentation)
- Notes: Machine check passes on tracked README.md headings. Human reviewer confirms marketplace listing prose quality before release.

### CHANGELOG

- Verdict: AWAITING-HUMAN
- Machine check: packaging-listing-credibility CHANGELOG release heading matching package.json version
- Notes: Machine check passes for the package.json version heading in CHANGELOG.md. Human reviewer confirms release notes are marketplace-ready before release.

## Redaction Rules

No secrets, tokens, absolute machine paths, or raw session dumps. Verdicts are
`PASS`, `FAIL`, or `AWAITING-HUMAN` only. Ground each verdict in the named
machine check; do not paste env values or host paths into Notes.

## Failure Modes

| Symptom | Signal |
|---------|--------|
| Ledger missing | `verify-m022-s05-listing-signoff` fails closed |
| Placeholder verdict (TODO/TBD/FIXME) | verifier rejects forbidden content |
| Secret-like text or absolute path | verifier rejects forbidden content |
| Machine check regression | `packaging-listing-credibility` fails; human verdict alone cannot green CI |

## Load Profile

Static markdown contract verified by node:test. No runtime load dimension —
there is no request path, pool, or pagination surface.

## Negative Tests

`scripts/verify-m022-s05-listing-signoff.test.mjs` rejects TODO/TBD/FIXME,
secret-like patterns, absolute machine paths, invalid verdicts, missing item
sections, and placeholder reviewer names. `scripts/packaging-listing-credibility.test.mjs`
covers undersized icons, missing README sections, and mismatched CHANGELOG
headings.
