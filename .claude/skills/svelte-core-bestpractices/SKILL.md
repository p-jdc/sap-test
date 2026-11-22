---
name: svelte-core-bestpractices
description: What good Svelte 5 looks like — runes, effects, props, events, snippets, styling, context, and async Svelte. Load alongside svelte-code-writer whenever writing or reviewing a .svelte component or .svelte.ts/.svelte.js module, or when deciding between $derived and $effect, context and module state, or a legacy API and its runes replacement.
---

# Svelte 5 Core Best Practices

Adapted from the official `svelte-core-bestpractices` skill (sveltejs, MIT), by way of the reference
app (play-bun-ai), with this repo's setup folded in.
Process (doc lookup, autofixer) lives in `svelte-code-writer`; this file is content only.

## State

- `$state` is for values that change **and** drive the UI. Everything else stays a plain `let`/`const`.
- `$state` returns a deep proxy — every nested property access is instrumented. For large objects that
  are replaced wholesale rather than mutated (API responses, parsed documents, fetched rows), use
  `$state.raw` and reassign.
- Prefer a class with `$state` fields over a store. Stores are legacy; classes give you methods,
  private fields, and type inference for free.

## `$derived` over `$effect`

- `$derived` takes an **expression**, not a function: `let doubled = $derived(count * 2)`.
  Use `$derived.by(() => { ... })` when you need statements.
- Deriveds are writable. Assigning to one is the idiomatic optimistic-UI move; it resets the next time
  a dependency changes.
- A derived that returns an object or array returns it **as-is** — the contents are not made deeply
  reactive. Reactivity tracks the derived's dependencies, not the shape it hands back.

## `$effect` is the escape hatch, not the tool

Reach for it only when nothing else fits, and never to keep one piece of state in sync with another —
that is what `$derived` is for. Writing state inside an effect is the single most common Svelte 5 bug.

| Need | Use |
| --- | --- |
| Derive a value from other state | `$derived` |
| Hand a DOM node to an imperative library (D3, maps, charts, editors) | `{@attach}` |
| React to user interaction | event handler or function binding |
| Observe something outside Svelte (media queries, sockets, external stores) | `createSubscriber` |
| See why something re-ran | `$inspect` / `$inspect.trace` |

- `{@attach}` supersedes `use:action`. Attachments are values, so they compose, take arguments
  reactively, and can be spread through props.
- **Never branch on `if (browser)` inside `$effect`.** Effects do not run during SSR — the guard is
  always true and only obscures intent.

## Props

- `let { a, b = 1, ...rest } = $props()`. Props change; treat them as live. Derive from them rather
  than copying into `$state`, or the copy silently goes stale.
- `$bindable` sparingly, and only where two-way flow is genuinely the simpler contract.

## Events

- Event handlers are plain attributes: `onclick`, not `on:click`. `{onclick}` shorthand and
  `{...props}` spread both work.
- Prefer `<svelte:window>` / `<svelte:document>` over adding and removing listeners inside `$effect`.

## Snippets and rendering

- `{#snippet}` / `{@render}` replace slots. `children` is just a prop.
- **Always key `{#each}` by a stable id**, never by index — index keys corrupt state on reorder.
- Avoid destructuring in `{#each}` when you intend to mutate. `{#each items as item}` with
  `bind:value={item.count}` works; `{#each items as { count }}` gives you a dead copy.
- **Components are dynamic by default in runes mode** — there is no replacement *element* for
  `<svelte:component>`. Put the component in a capitalized variable and render it:
  `const Cmp = $derived(map[kind]);` then `<Cmp {...props} />`.
- `import Self from './Self.svelte'` over `<svelte:self>`.

## Styling

- Pass dynamic values into CSS with a custom property: `style:--columns={columns}`, then
  `grid-template-columns: repeat(var(--columns), 1fr)`.
- Style a child component through custom properties — `<Child --color="red" />` — not `:global`.
  Reserve `:global` for third-party markup you do not control.
- Conditional classes go in a clsx-style array: `class={['btn', active && 'btn-active']}`, not `class:`.

## Context

- `createContext<T>()` (Svelte 5.40+; our `package.json` floor is `^5.57.3`, so it is available)
  over the `setContext`/`getContext` pair.
  It returns `[get, set, has]`, is typed at the call site, and needs no string key.
- Both `get` and `set` must run during component initialization.
- **Mutate** the context object to keep the reactive link alive; reassigning it breaks the link.
- Context, not module-level state, for anything per-user. Module-level state on the server is shared
  across requests and leaks between users — context scopes it to the component tree.

## Async Svelte — enabled in this repo

`compilerOptions.experimental.async` is `true` in `vite.config.ts`, so `await` in components is
live here. Two traps the reference app has already hit:

- **Never `await` inside the reactive graph on a streaming-hot path**. A `$derived(await …)`
  in a component that mounts mid-stream wedges Svelte's batch scheduler and freezes effect flushing
  *page-wide*, with healthy state and a clean console. Render a sync fallback and land `.then()`
  results into `$state`. `{#await}` blocks don't batch-participate and are always safe. This is
  narrower than "no await in a derived" — read the reference before working around it.
- **In tests, the async flag defeats `await`-based ordering assertions.** Pin ordering with
  `flushSync()`, not `await tick()`.

One reference carries the detail — load it only when the task calls for it:

- [`references/await-expressions.md`](references/await-expressions.md) — the full `await` surface
  (synchronized updates, concurrency, `<svelte:boundary>` pending snippets, `$effect.pending()`,
  `settled()`, `fork()`), plus the symptom signature of the wedge above and how to distinguish it
  from a data bug.

## Legacy APIs and their replacements

| Legacy | Use instead |
| --- | --- |
| `export let` | `$props()` |
| `$:` reactive statement | `$derived` / `$effect` |
| stores (`writable`, `$store`) | class with `$state` fields |
| `on:click` | `onclick` |
| slots | snippets |
| `<svelte:component>` | a capitalized variable — `const Cmp = $derived(…)`, then `<Cmp />` |
| `<svelte:self>` | `import Self from './Self.svelte'` |
| `use:action` | `{@attach}` |
| `class:active` | `class={['btn', active && 'active']}` |
| `onMount` for setup | `$effect`, `{@attach}`, or an event handler |

## Checking your work

Doc lookups and `svelte-autofixer` runs go through the `svelte-docs` agent — never call the svelte
MCP from the main conversation.
