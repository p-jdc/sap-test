# anti-slop lint rules

Five rules from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT, see `LICENSE`), copied
unchanged from the selection the play-bun-ai project uses. oxlint loads them as a JS plugin in both
`sap-tests/.oxlintrc.json` and the root `.oxlintrc.json`; they need `@oxlint/plugins`.

| Rule | Flags |
| --- | --- |
| `no-reflect-get`, `no-reflect-apply` | `Reflect.get` / `Reflect.apply` used to get around the types |
| `no-chained-type-assertions` | `value as unknown as T` |
| `no-unknown-type-aliases` | a type alias that is just `unknown` |
| `no-unsafe-dictionary-type` | `Record<string, unknown>` and the like outside tests |

The files are not linted or formatted with this project's settings, so they stay comparable with
their source.
