---
description: Check the current branch before a pull request. Runs the mechanical checks (`bun run pregate`), then one review of the branch's changes against main with each serious finding checked a second time, and ends in one PASS or FAIL line for the pull request description.
argument-hint: '[review-only]   (skip the mechanical checks when they have just passed on this commit)'
allowed-tools: Bash, Read, Grep, Glob, Agent
---

# Gate

A smaller form of the reference app's four-lens review: one reviewer, a second look at serious
findings, a verdict decided by rule. It keeps no record between runs; every run reviews the whole
branch against main.

The gate is a convention. Nothing on GitHub stops a merge without it, and it judges the commit it
ran on, not later ones.

## 1. What is under review

```bash
ROOT="$(git rev-parse --show-toplevel)"
git -C "$ROOT" fetch -q origin main
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
BASE="$(git -C "$ROOT" merge-base HEAD origin/main)"
echo "ROOT=$ROOT"; echo "HEAD=$HEAD_SHA"; echo "BASE=$BASE"
git -C "$ROOT" status --porcelain
git -C "$ROOT" diff --stat "$BASE" HEAD
```

- **Uncommitted changes: stop** with "the gate needs a clean tree; commit first". The verdict is
  about a commit.
- **Empty diff: stop** with "nothing to review".
- **The branch changes the gate itself** (`.claude/commands/gate.md`, `.claude/agents/gate-*.md`,
  `scripts/pregate.ts`, the `pregate` script in `package.json`, a lint or type configuration, or
  `.github/workflows/`): go on with the full gate, and put `GATE TOOLING CHANGED: <files>` above
  the verdict, whatever the verdict is. A branch cannot be vouched for by checks it rewrote; a
  person has to read those files. This rule comes before the next one.
- **Only documentation changed:** run step 2, skip the review, and end with
  `GATE: PASS (checks only, documentation change)`. Documentation means `*.md` files that people
  read. Files that instruct agents are reviewed like code and never count: `CLAUDE.md`,
  `sap-tests/CLAUDE.md`, and everything under `.claude/agents/`, `.claude/commands/` and
  `.claude/skills/`.

## 2. Mechanical checks

Skip only with the argument `review-only`.

```bash
bun run pregate
```

It prints one line per check and `PREGATE: PASS` or `PREGATE: FAIL (…)` with the output of every
failed check. On FAIL, stop: report `GATE: FAIL (checks)` with that output. Do not start a
reviewer; there is no point paying for a review of code the machines already reject. In a new
worktree a failure in every step means `bun run setup` has not run.

## 3. Review

Start the `gate-reviewer` agent with `LENS: general`, passing `ROOT`, `BASE` and `HEAD` as the
values printed in step 1 (full commit ids, the absolute path). Do not paste the diff into the
prompt and do not describe what the change is meant to do beyond one neutral sentence: the
reviewer reads the code itself, and a reviewer told the intent tends to confirm it.

Start a second `gate-reviewer` with `LENS: security`, in the same message so both run together,
only if the diff touches one of these:

- `app/src/lib/server/auth/`, `app/src/lib/server/db/`, `app/drizzle/`
- `app/src/hooks.server.ts`, `app/src/lib/server/origin.ts`, `host-check.ts`
- `app/src/lib/server/secret-store.ts`, `env-file.ts`, `setting-value.ts`, `redact.ts`, `systems.ts`
- `app/src/lib/server/file-response.ts`, any `+server.ts`, any `*.remote.ts`
- `app/src/lib/server/runner.ts`, `recorder.ts`, `mfs.ts` (they start processes)
- `sap-tests/sap-plugin/secret.ts`, `systems.ts`, `systems-schema.ts`, `login.ts`, `sign-in.ts`,
  `session.ts`, `secure-url.ts`
- `sap-tests/mfs/http.mts`, `server.mts`
- `.github/workflows/`, `.claude/settings.json`

Each answers with JSON: `head`, `filesRead`, `findings`.

**The review is incomplete, and has no verdict, when** an agent failed, answered without JSON,
reported `"error"`, or its `head` is not `HEAD_SHA`. Run that agent once more; if it fails again,
end with `GATE: INCOMPLETE (<what is missing>)`.

**Check where the findings point.** Compare each finding's file with
`git -C "$ROOT" diff --name-only "$BASE" HEAD`. A finding outside the diff counts only if it names
a caller or callee of changed code. If most of a reviewer's findings are outside the diff, it
looked at the wrong checkout: treat that reviewer as failed.

## 4. Second look

For every `blocker` and `high` finding, start one `gate-verifier` (all in one message), giving it
the finding as the reviewer wrote it, `ROOT` and `HEAD`. Do not add your own opinion of the
finding. `medium` and `low` findings are not verified; they are advice.

A verifier that fails or answers without JSON counts as `uncertain`.

Use the verifier's severity when it gives a different one with a reason.

## 5. The tree afterwards

```bash
git -C "$ROOT" status --porcelain
```

The run started on a clean tree, so anything listed now was written by an agent despite its
instructions. Look at it with `git diff`. A change to code under review (a flipped condition, a
stubbed check) is contamination: restore it with `git -C "$ROOT" checkout HEAD -- <path>`, say in
the report what was restored, and drop any finding that rests on it. Anything you cannot identify:
show it to the user and ask; do not discard it.

## 6. Verdict

Merge findings from both reviewers that name the same place and cause. Then, by rule, not by
judgment:

- **FAIL** if any `blocker` or `high` is `confirmed`, or any `blocker` is `uncertain`.
- **PASS-WITH-FIXES** if anything else is left: `medium` and `low` findings, a `high` that stayed
  `uncertain`.
- **PASS** if nothing is left.

Print the findings that count, most serious first:

```
[SEVERITY · confirmed | uncertain | not verified] Title
path:line — how it goes wrong
Fix: …
```

Then list every refuted `blocker` and `high` with its location and the verifier's reason, so that
a wrongly refuted one is visible to a person. Then one final line:

- `GATE: PASS` on `<short HEAD>`
- `GATE: PASS-WITH-FIXES (<n> to fix or consciously leave)` on `<short HEAD>`
- `GATE: FAIL (<n> confirmed)` on `<short HEAD>`

## 7. Afterwards

- On FAIL: fix, commit, run `/gate` again.
- On PASS-WITH-FIXES: fix each item or say why it stays. Fixes change the commit, so the checks
  must pass again (`bun run pregate`); a second review is needed only if a fix went beyond the
  listed items.
- The pull request description gets a section `## Gate` with the final line, the findings that
  were left open and why, and every refuted `blocker` or `high`. Do not write `GATE: PASS` into a
  description for a commit the gate did not run on.
