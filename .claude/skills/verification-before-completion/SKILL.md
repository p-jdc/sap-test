---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

<!-- Vendored from obra/superpowers v7.0.0 (MIT, see LICENSE) and adapted to this repo, by way of the reference app (play-bun-ai). -->

# Verification Before Completion

## Overview

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim                 | Requires                        | Not Sufficient                 |
| --------------------- | ------------------------------- | ------------------------------ |
| Tests pass            | Test command output: 0 failures | Previous run, "should pass"    |
| Linter clean          | Linter output: 0 errors         | Partial check, extrapolation   |
| Build succeeds        | Build command: exit 0           | Linter passing, logs look good |
| Bug fixed             | Test original symptom: passes   | Code changed, assumed fixed    |
| Regression test works | Red-green cycle verified        | Test passes once               |
| Agent completed       | VCS diff shows changes          | Agent reports "success"        |
| Requirements met      | Line-by-line checklist          | Tests passing                  |

## In This Repo

Which command proves which claim (from the repo root unless noted):

- **Types:** `bun run check` (svelte-check for `app`, tsc for `sap-tests`). oxlint is a linter; it does not prove types.
- **Lint and format:** `bun run lint`. `bun run lint:light` (no eslint) is for iterating only.
- **Unit tests:** `bun run test`, or one file with `bunx vitest --run <path>`.
- **The app works in a browser:** `bun run test:e2e`, or the `verify` skill for a flow the e2e tests do not cover. A passing unit test does not prove it.
- **SAP test code:** `bun run test:plugin`, `bun run test:mfs`, `bun run test:api:mock`. These run without an SAP system. A test against a real system proves nothing until it has run against that system: say so when it has not.
- **Ready for a pull request:** `/gate` ended in `GATE: PASS`, or in `PASS-WITH-FIXES` and each listed item is fixed or its reason for staying is written down (it runs `bun run pregate` and a review). The verdict belongs to the commit it ran on: after fix commits, `bun run pregate` must pass again, and `/gate` again only when they change more than the listed items. `bun run pregate` alone is enough only for a documentation change; `CLAUDE.md` files and everything under `.claude/` are not documentation and get the gate. CI on the pushed branch adds the e2e tests.
- **A regression test works:** name the change you undid and show the test went red.
- **A worktree:** has no dependencies until `bun run setup`; a failure before that proves nothing.
- **After a merge that changes `package.json`:** `bun install` in the main checkout's `app` and `sap-tests`, or the running app fails on a missing module.

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse                                  | Reality                |
| --------------------------------------- | ---------------------- |
| "Should work now"                       | RUN the verification   |
| "I'm confident"                         | Confidence ≠ evidence  |
| "Just this once"                        | No exceptions          |
| "Linter passed"                         | Linter ≠ compiler      |
| "Agent said success"                    | Verify independently   |
| "I'm tired"                             | Exhaustion ≠ excuse    |
| "Partial check is enough"               | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter     |

## Key Patterns

**Tests:**

```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**

```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**

```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**

```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**

```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## When To Apply

**ALWAYS before:**

- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**

- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness
