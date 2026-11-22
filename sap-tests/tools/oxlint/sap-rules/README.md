# Lint rules for SAP tests

The rules from `sap-tests/CLAUDE.md` that a machine can decide, as an oxlint JS plugin (`sap`),
loaded by `sap-tests/.oxlintrc.json`. Written here, and linted and type-checked like the rest of
the project.

| Rule                    | Flags                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sap/no-secret-fill`    | `fill`, `type` or `pressSequentially` on a locator that names a password field (Password, Passwort, Kennwort, pwd), or with a value named like a password. These write the value into the report and the Test-App's run data; `fillSecret` does not |
| `sap/no-literal-secret` | A password written into the code as the second argument of `fillSecret` or `SAPLogin`                                                                                                                                                               |

Two more rules from `CLAUDE.md` use rules oxlint already has, configured in `.oxlintrc.json`:
`waitForTimeout` (`no-restricted-properties`) and `test`/`expect` imported from `@playwright/test`
in a file under `tests/` (`no-restricted-imports`).

The password rules go by names, as whole words: `Password`, `Passwort`, `Kennwort`, `pwd` in the
locator, and those or `secret` at the end of the value's name (`SAP_PASSWORD`, `user.password`).
`no-literal-secret` follows a `const` to the string it holds.

- They miss a password field whose locator does not say so (`getByLabel('PIN')` with a value
  called `code`), and a password passed through a function or an object.
- They flag a field that merely has the word in its name (`getByLabel('Password policy')`). Exempt
  such a line with `// oxlint-disable-next-line sap/no-secret-fill -- <reason>`.
- They are off for `tests/_plugin`, where the plugin's own tests type made-up passwords into local
  pages.

`fixtures/` holds lines that must and must not be flagged, each marked `// expect: <code>`.
`tests/_plugin/lint-rules.spec.ts` lints them with `fixtures/lint.json` and compares. The folder is
excluded from the normal lint run. `lint.json` repeats the import rule's options from
`.oxlintrc.json`; the test fails when the two differ, and when the project configuration no
longer has the rules switched on.

The Test-App has rules with the same names for its flow view
(`src/lib/server/spec-parser.ts`). They are related, not identical, so a finding can appear in
one tool only:

- The app looks at `fill` alone; the linter also at `type`, `pressSequentially` and
  `page.fill(selector, value)`.
- The app matches `pass` anywhere in the locator (so also "Passenger"); the linter whole words.
- A literal typed into a password field is `no-literal-secret` in the app and `no-secret-fill`
  here.
