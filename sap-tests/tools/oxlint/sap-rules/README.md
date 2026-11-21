# Lint rules for SAP tests

The rules from `sap-tests/CLAUDE.md` that a machine can decide, as an oxlint JS plugin (`sap`),
loaded by `sap-tests/.oxlintrc.json`. Written here, and linted and type-checked like the rest of
the project.

| Rule | Flags |
| --- | --- |
| `sap/no-secret-fill` | `fill`, `type` or `pressSequentially` on a locator that names a password field (Password, Passwort, Kennwort, pwd), or with a value named like a password. These write the value into the report and the Test-App's run data; `fillSecret` does not |
| `sap/no-literal-secret` | A password written into the code as the second argument of `fillSecret` or `SAPLogin` |

Two more rules from `CLAUDE.md` use rules oxlint already has, configured in `.oxlintrc.json`:
`waitForTimeout` (`no-restricted-properties`) and `test`/`expect` imported from `@playwright/test`
in a file under `tests/` (`no-restricted-imports`).

The password rules go by names. They miss a password field whose locator does not say so
(`getByLabel('PIN')` with a value called `code`), and they are off for `tests/_plugin`, where the
plugin's own tests type made-up passwords into local pages.

`fixtures/` holds lines that must and must not be flagged, each marked `// expect: <code>`.
`tests/_plugin/lint-rules.spec.ts` lints them with `fixtures/lint.json` and compares. The folder is
excluded from the normal lint run. `lint.json` repeats the import rule's options from
`.oxlintrc.json`; change both together.

The Test-App applies the same rules per test for its flow view
(`app/src/lib/server/spec-parser.ts`, rules `no-secret-fill`, `no-literal-secret`,
`no-fixed-wait`). It matches password fields a little more loosely (`pass` anywhere in the name).
