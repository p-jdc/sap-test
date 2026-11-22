---
name: svelte-code-writer
description: Process for creating or editing any Svelte component (.svelte) or Svelte module (.svelte.ts/.svelte.js) — how to look up documentation and how to validate the result. MUST be used for every such edit. Pair it with the svelte-core-bestpractices skill, which carries the actual Svelte 5 guidance.
---

# Svelte 5 Code Writer

How to write Svelte in this repo. This file is process; the guidance itself lives in
`svelte-core-bestpractices` — load both.

## The one hard rule

**Never call the svelte MCP from the main conversation.** Every documentation lookup and every
`svelte-autofixer` run goes through the `svelte-docs` agent, which has the MCP tools and returns a
distilled brief. Raw documentation sections must never enter the main context.

**If the MCP is unavailable, say so — never silently substitute memory.** The server is a local
process (`.claude/mcp/`, installed with `bun run setup:mcp` from the repo root); if that install is missing the agent comes back with no
tools and an answer drawn from model recall, which looks identical to a real lookup. When
`svelte-docs` reports it could not reach the MCP, tell the user the lookup failed and what the
unverified answer is based on, rather than presenting it as documented.

## Workflow

1. **Answer from what you know.** Svelte 5 runes are well-established; most edits need no lookup.
   Load `svelte-core-bestpractices` and write the code.

2. **If you need documentation** — an API you are unsure of, a SvelteKit behaviour, anything where a
   wrong guess would be silent:
   - Check `resources/documentation-paths.md` for the section path first. If it is listed, name that
     path in your request — the agent then fetches it directly and skips `list-sections`, which
     otherwise pulls ~35k characters (~8.8k tokens) into its context on every dispatch. That file is
     a cache and a few entries have gone stale; the agent falls back to `list-sections` and tells
     you which path missed, so prune it when that happens.
   - Dispatch `svelte-docs` with **one focused question**. Ask for a distilled answer, not sections.
   - Batch related questions into a single dispatch — the agent fetches the union of sections in one
     call, which is far cheaper than three round trips.

3. **Write the code**, following `svelte-core-bestpractices`.

4. **Validate.** Dispatch `svelte-docs` to run `svelte-autofixer` on the files you touched and return
   only actionable issues with `file:line`. Apply the fixes. Re-validate only if the fixes were
   substantive.

5. **Type-check** with `bun run check` (it runs `svelte-kit sync` first; bare
   `svelte-check` can report stale errors).

## Notes

- The MCP also exposes `playground-link`, but `svelte-docs` is **not** granted that tool, so there
  is no reachable path to it today. Don't offer a playground link; if we ever need one, add the
  tool to that agent deliberately.
- The UI is built from UI5 Web Components (`<ui5-…>` custom elements, registered in
  `src/lib/ui5.ts`). The Svelte documentation does not cover them: for a component's
  properties, slots and events, read its definition under `node_modules/@ui5/` or the UI5 Web
  Components documentation.
