# Repository Guidelines

## Project Layout

- `extensions/bg-shell/` contains the TypeScript extension source (`tasks.ts` registry core, `notify.ts` completion notifier, `tools.ts` model-facing tools, `command.ts` the `/bg` command family, `panel.ts` the overlay panel component, `status-bar.ts` the persistent status widget, `index.ts` entry).
- `tests/` contains the `node:test` test files.
- `scripts/` contains repo-level checks (`check-docs.mjs`).
- `docs/` holds decision records, pitfalls, and postmortems; `CONTEXT.md` is the domain glossary.
- `README.md` and `README.zh-CN.md` document user-facing behavior in English and Simplified Chinese.

## Development Commands

```bash
npm install
npm test             # node:test suite + mechanical doc gates
npm run typecheck
npm run check:docs   # doc gates alone (same checks npm test chains in)
pi --extension .
```

Use `npm test` for the full test suite (the doc gate runs at the end) and `npm run typecheck` for the strict TypeScript check. Use `pi --extension .` to exercise the extension interactively.

## Task Classification

Before any implementation task — a new feature, a non-trivial multi-file change, a settings/config contract change, or anything touching how pi's extension surface is patched — state the classification and surface the design (approach, alternatives, risks) for confirmation first. Producing code or files before that confirmation is the forbidden pattern for implementation-grade tasks.

Exempt (proceed directly): pure Q&A or read-only exploration; docs/typo/comment-only edits; a bug fix with a concrete reproduction and scope from the user; mechanical edits with no design decision; anything the user explicitly says to just do. When ambiguous, default to asking, and state the classification so it can be corrected.

Decisions that survive the discussion become an ADR — see `docs/adrs/README.md` for the format and the entry threshold (hard to reverse / confusing without context / a real trade-off — one of these).

## BG Task Protocol

Three hard rules for any `bash_bg` task spawned while working in this repo — distilled from a 68-hour, ~70-task dogfooding session (2026-10, "session13"):

1. **Script-file contract.** The task `command` is only ever `bash <path>/script.sh`, with the script written via `write` first. Inline shell in `command` crosses the model → adapter → spawn layers, where variables get eaten and nested quotes get mangled; after adopting this rule the reference session had zero spawn-layer incidents.
2. **Results land in files.** A task writes its findings to a file, and the file is read in a separate call. Completion-notify tails are occasionally truncated by the same boundary — treat the tail as a ping, not the record. The tail also lies about freshness: after a host-sleep gap the catch-up report makes a 9.5-hour-old task look freshly armed, while the elapsed figure was accurate to +0.1s (session13 audit: 296/312 events within 1s of spawn-time accounting) — trust timestamp math over tail-implied age.
3. **Resident, self-throttled watches for recurring conditions.** If the alert can fire again, the watch stays resident (`timeout_sec: 0`, `detach: true` when it must outlive the session) and wakes via `on_pattern_all` — **not** plain `on_pattern`, which fires exactly once then stays silent forever while still looking armed (worse than re-arming: a confident blind spot). The script gates markers on state *transitions* — echo when a condition enters, not while it persists (the old `echo marker && exit 0` used re-arming as its reset; hysteresis replaces that) — and the tool's 10 s min-fire floor only guards against stampedes. One-shot watchers (`watch-done`: a trigger that occurs once) may keep the fire-and-exit shape, and need no pattern at all when plain completion notify carries the tail. Forbidden is the manual re-arm loop for recurring alerts — the reference session burned 78 rate + 35 sweep re-arms, 113 of its 132 spawns (86%): its rate script echoed `***RATE_LOW***` then `exit 0`, and sweep signalled via `exit 3`, the same anti-pattern in a `failed` costume (33 false-failure notifies).

## Documentation Layout

| Document | Answers | Location |
|----------|---------|----------|
| ADR | why a decision was made | `docs/adrs/NNNN-slug.md` (rules: `docs/adrs/README.md`) |
| Glossary | what each domain term means | `CONTEXT.md` (each entry carries an `_Avoid_` anti-synonym) |
| Pitfalls | how to avoid known traps | `docs/PITFALLS.md` |
| Postmortems | incident reviews feeding PITFALLS | `docs/postmortems/` |
| Feature design docs | what to build | `docs/specs/` (create on first use) |

- ADRs use the Nygard format plus a mandatory `Considered Options` section; rejected alternatives get a Rejected ADR too, and superseded ADRs are never deleted — the doc gate enforces all of it.
- Incident loop: qualifying incident → postmortem (`docs/postmortems/README.md` template) → PITFALLS entry (Trap / Why / Avoid / Recovery), cross-linked. The entry threshold in `docs/PITFALLS.md` keeps the rulebook dense.

## Git & PR Discipline

- **Code changes reach `main` through a pull request** — branch `type/scope/short-desc` off `main` (e.g. `feat/tools/bg-detach`), push, open the PR. Never merge locally and push `main` directly. Docs-only or typo-level fixes may go direct; when in doubt, open a PR.
- **Conventional Commits**: `type(scope): subject` — types `feat|fix|refactor|perf|chore|docs|style|test`; scopes `bg|tasks|notify|tools|docs|ops` (or the module actually touched).
- **PR description**: what + why, plus an issue binding — `Closes #N` / `Refs #N` / `No-Issue: <reason>`. CI rejects a PR body containing none of these.
- **Hard gate before merge**: `npm test && npm run typecheck` green. CI runs it on every PR; run it locally too when touching code.
- **Squash-merge**, then delete the branch.
- **Agent vs human**: the agent handles branch/commit/push/open-PR and prepares gate evidence; review and merge are the maintainer's call — the agent never runs `gh pr merge`, not even when the user authorizes a release ("发新版" authorizes tag/publish after the user merges; it never delegates the merge itself).
- **Releases** (once first published): version-bump branch → PR (`No-Issue: version bump`) → **maintainer merges first** → push the `vX.Y.Z` tag (creates a draft release only) → fill highlights → **publishing is what triggers npm publish** (irreversible). Never push a release tag before the PR is merged. Direct-pushing main is always declined anyway.
- Never stage with a bare `git add -A` / `git add .` — stage explicit paths.

## Quality Gate Placement

New checks pick a host by shape — no scattering:

| Check shape | Host | Precedent |
|-------------|------|-----------|
| Repo-wide, second-scale, zero-dependency | script in `scripts/`, chained into `npm test` | `check-docs.mjs` |
| TypeScript compile level | `npm run typecheck` | `tsc --noEmit` |
| Behavior under a real pi runtime | manual `pi --extension .` | — |
| PR-only metadata checks (issue binding) | step in `.github/workflows/pr-checks.yml` | `pr-issue-link` job |
| Staged-file-level checks | git hooks — add only when a real need appears | — |

## Code Conventions

- Keep changes focused and reuse existing modules before adding new abstractions or dependencies.
- Follow the existing TypeScript style: tabs for indentation, double quotes, trailing commas, and explicit `.ts` extensions in relative imports.
- **Erasable TypeScript only** in `extensions/` and `tests/` (Node runs them via native type-stripping): no `enum`, no namespaces, no constructor parameter properties — see `docs/PITFALLS.md` P2.
- Preserve strict typing. Validate data at external boundaries and keep compatibility workarounds isolated.
- Do not reformat or refactor unrelated code.

## Tests and Documentation

- Add or update focused `node:test` coverage for behavior changes.
- Run the relevant tests and `npm run typecheck` before finishing. For a full check, run `npm test && npm run typecheck`.
- When adding or changing an ADR, keep the `docs/adrs/README.md` index in sync — the doc gate enforces it.
- When tools, messages, or other user-visible behavior changes, update both README files where applicable, and add or adjust `CONTEXT.md` entries when a concept is introduced or its meaning shifts.
- Do not edit `package-lock.json` unless dependency metadata changes.
