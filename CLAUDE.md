# Working in this repository

Rules for SAP tests are in sap-tests/CLAUDE.md. This file covers how changes are made.

## Worktrees by default

- Make every change in its own git worktree on its own branch, under `.claude/worktrees/<branch-name>`, created from an up-to-date `main`. The main checkout stays on `main` and stays clean.
- Exceptions: read-only work (questions, reviews, running tests), and when the user says to work in the main checkout.
- A new worktree has no installed dependencies. Run `bun run setup` in it before running checks or tests.
- Never touch a worktree another session created, including locked ones.

## After a pull request is merged

Clean up without being asked, as soon as the merge is confirmed:

1. Remove the worktree: `git worktree remove .claude/worktrees/<branch-name>`.
2. Update main: `git switch main && git pull --ff-only`.
3. Delete the local branch: `git branch -d <branch-name>`.
4. Delete the remote branch if GitHub has not done so, then prune: `git fetch --prune`.
5. Finish with `git worktree prune`.

Only clean up what belongs to the merged pull request. If a worktree has uncommitted changes or a branch has unmerged commits, stop and report it instead of forcing the removal (`--force`, `-D`).
