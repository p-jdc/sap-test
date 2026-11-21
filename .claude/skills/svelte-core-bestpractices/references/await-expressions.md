# `await` in components

Adapted from the official Svelte skill reference. **Read the warning first — it
contradicts upstream's advice on one point. It comes from the reference app (play-bun-ai), which
hit the bug; this app streams live runs the same way.**

`compilerOptions.experimental.async` is `true` in `app/vite.config.ts`, so all of this is
live. The flag goes away in Svelte 6.

Since 5.36, `await` works in three places it previously didn't:

- the top level of a component's `<script>`
- inside `$derived(...)`
- inside markup

## Contents

- [The warning: `await` inside the reactive graph on streaming paths](#the-warning-await-inside-the-reactive-graph-on-streaming-paths)
- [Synchronized updates](#synchronized-updates)
- [Concurrency](#concurrency)
- [Loading states](#loading-states)
- [Errors](#errors)
- [Server-side rendering](#server-side-rendering)
- [Forking](#forking)
- [Testing](#testing)
- [Stability](#stability)

## The warning: `await` inside the reactive graph on streaming paths

Upstream presents `$derived(await …)` as a supported feature. In the reference app it has wedged
the whole page, and the failure is nasty enough to be worth the paragraph.

Under `experimental.async`, a `$derived(await …)` or a template `await` joins the current
effect batch as pending work. When such a component **mounts mid-stream** — our case was chat
tool chips → `ToolInput`/`ToolOutput` → the then-shiki `CodeBlock`'s highlight — the batch defers its
effects and then never re-flushes them, *even after pending work returns to zero*. Observed on
Svelte 5.56.6; likely an upstream bug, no matching issue found.

**Symptom signature.** UI frozen (chips stuck Pending, submit stuck "generating"), SSE stream
fully consumed, `$state` provably advancing if you poll it, `$derived` recomputing on read —
but no `$effect` re-runs and no cleanup fires. Zero console errors. A reload renders perfectly.
State and invalidation are healthy; only effect *flushing* is dead.

**How to tell it apart from a data bug.** (a) pull-driven tap on the SSE body, (b) an untracked
`setInterval` poll of the same state, (c) a probe `$effect` on one plain `$state`. If (a) and
(b) advance while (c) dies, it's the batch wedge.

**The rule.** Never `await` inside the reactive graph on a streaming-hot path. Render a
synchronous fallback, land async results from `.then()` into `$state`, and guard staleness in an
`$effect`.

**`{#await}` blocks do not participate in batching and are always safe.** They are the escape
hatch when you need async rendering on a hot path.

This is not a blanket ban on `await` in components — a `$derived(await …)` in a component that
mounts at page load, away from streaming, is fine and is what the rest of this file describes.

## Synchronized updates

State changes an `await` expression depends on are not reflected until the async work finishes,
so the UI is never inconsistent. Given `{a} + {b} = {await add(a, b)}`, incrementing `a` does
not flash `2 + 2 = 3` — the text updates to `2 + 2 = 4` when `add` resolves. Updates can
overlap: a fast update lands while an earlier slow one is still in flight.

## Concurrency

Independent `await` expressions in markup run in parallel even though they read as sequential:

```svelte
<p>{await one(x)}</p>
<p>{await two(y)}</p>
```

This does *not* apply to sequential awaits inside `<script>` or inside an async function — those
behave like any other async JavaScript. Independent `$derived`s update independently once
created, though they are created sequentially:

```js
// `b` isn't created until `a` resolves; afterwards they update independently
let a = $derived(await one(x));
let b = $derived(await two(y));
```

Expect an `await_waterfall` warning if you write that.

## Loading states

Wrap content in `<svelte:boundary>` with a `pending` snippet — shown when the boundary is first
created, not on subsequent updates. After the first resolve, detect further async work with
`$effect.pending()` (this is the "validating your input" spinner). `settled()` returns a promise
that resolves when the current update completes:

```js
import { tick, settled } from 'svelte';

async function onclick() {
	updating = true;
	await tick(); // without this, `updating` batches with the changes below and never shows

	color = 'octarine';
	answer = 42;

	await settled();
	updating = false;
}
```

## Errors

Errors in `await` expressions bubble to the nearest `<svelte:boundary>`.

## Server-side rendering

`render(...)` is awaitable; SvelteKit does this for us. A `<svelte:boundary>` with a `pending`
snippet encountered during SSR renders that snippet and ignores the rest. Awaits outside such
boundaries resolve and render before `await render(...)` returns.

## Forking

`fork(...)` (5.42+) speculatively runs `await` expressions you expect to need shortly —
preloading on hover or focus, then `commit()` or `discard()`. Mainly for frameworks; SvelteKit
uses it for navigation preloads. Reach for it only with a measured reason.

## Testing

**The async flag defeats `await`-based ordering assertions.** Pin ordering with `flushSync()`,
never `await tick()`. (The `svelte-testing` skill covers the harness but does not carry this
rule — it lives here.)

## Stability

Experimental: `await` handling and `$effect.pending()` can break outside a semver major. Effects
already order differently under the flag — block effects (`{#if}`, `{#each}`) now run before an
`$effect.pre` or `beforeUpdate` in the same component.
