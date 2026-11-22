# Regeln für SAP-Tests

Dieses Projekt nutzt Standard-Playwright mit dem SAP-Plugin in sap-plugin/ (Locators aus Playwright-SAP). Tests importieren `test` und `expect` aus sap-plugin (z. B. '../../sap-plugin'), nicht aus '@playwright/test'.
Fiori wird mit dem Recorder des Plugins aufgezeichnet (`bun run record <url>` oder „Record a test“ in der App). Playwright-SAP selbst liegt nur noch in recorder/ und dient ausschließlich dem Aufzeichnen von WebGUI und von Systemen, die sich nicht mit der SAP-Anmeldung anmelden (z. B. Ariba). Welche Ordner und welcher Recorder je System, ergibt sich aus systems.json (README, „Adding a system“).
Neue Tests folgen dem Aufbau von tests/_reference/gold-standard.spec.ts.

## Locators in dieser Reihenfolge

1. Fiori/UI5: page.getByRoleUI5(controlType, { eigenschaft: wert }). Mehrere Eigenschaften in einem Aufruf müssen alle zutreffen; so wenige wie nötig angeben, damit das Control eindeutig ist.
   Bestimmen auch mehrere Eigenschaften das Control nicht eindeutig (Zeile einer Liste, gleichlautende Links): page.locateUI5Control({ ... }) mit `bindingPath` oder `ancestor`, so wie der Recorder es schreibt. Aufgezeichnete locateUI5Control-Schritte bleiben, wie sie sind.
2. WebGUI: page.getByRoleSID(role, { name, pos, sub, wnd }). Für Tabellenzellen und eigene Controls: page.locateSID('<vollständiger SID-Pfad>').
3. Ariba und Nicht-SAP-Seiten: getByRole, getByLabel, getByText.

Auf SAP-Bildschirmen nie CSS-Selektoren, XPath oder generierte IDs. .nth() nur, wenn keine Eigenschaft das Control eindeutig bestimmt.

## Aufbau

- Hilfsfunktionen aus helpers/ verwenden, wenn es eine passende gibt.
- Anmeldung mit page.SAPLogin und Umgebungsvariablen. Die Systeme, an denen Tests angemeldet starten, und ihre Ordner stehen in systems.json; setup/sign-in.setup.ts meldet sich je Lauf einmal ohne Trace an und speichert die Sitzung. Tests unter tests/fiori (außer demokit), tests/webgui und tests/_reference starten so an SAP angemeldet; page.SAPLogin öffnet dann nur die Adresse. Tests anderer Systeme (z. B. tests/ariba) öffnen nur die Adresse und melden sich nicht selbst an. Ein neues System ist eine Zeile in systems.json und ein Ordner unter tests/.
- Passwörter mit `fillSecret(locator, wert)` aus sap-plugin eintippen, nie mit `fill`: `fill` schreibt den Wert in den Bericht und die Laufdaten der Test-App. page.SAPLogin tut das bereits.
- Ein Geschäftsablauf je Test. Nach jedem datenverändernden Schritt prüfen.
- Keine festen Wartezeiten (waitForTimeout). Auf ein Control oder eine Statusmeldung warten.
- `await page.waitForUI5()` nur vor Abfragen, die nicht selbst warten (Modell lesen, count(), Screenshot). Vor Klicks und `expect` auf Locators ist es unnötig.

## UI5-Modell lesen (Fiori)

- `page.ui5BoundData(locator)`: die Einträge, die eine Liste oder Tabelle geladen hat ('rows' als zweites Argument für sap.ui.table).
- `page.ui5ModelProperty(locator, pfad)`: ein Wert aus dem Modell. Pfad mit '/' ab der Wurzel, sonst relativ zum Eintrag, den das Control zeigt.
- `page.ui5HasPendingChanges(locator)`: ob das OData-Modell ungespeicherte Änderungen hält.
- Diese Abfragen wiederholen sich nicht: vorher `page.waitForUI5()` aufrufen. Sie ergänzen die Prüfung der sichtbaren Oberfläche, ersetzen sie aber nicht.

## API-Tests (OData)

- Tests, die SAP-Services aufrufen, importieren `test` und `expect` aus '../../sap-plugin/odata'. Die SAP-Locators bleiben verfügbar.
- Aufrufe nur über die typisierten Clients der Fixtures (z. B. `gwsample`) mit `.execute(sapApi)`. Keine selbst gebauten OData-URLs mit fetch.
- Erzeugte Daten sofort nach dem Anlegen mit `cleanup(label, undo)` zum Löschen anmelden.
- Testdaten bevorzugt über die API anlegen und prüfen, den Geschäftsablauf selbst in der UI.
- Die Clients unter odata/clients nie von Hand ändern und nicht einchecken. Sie werden bei jedem `bun install` (oder mit `bun run odata:generate`) aus odata/metadata erzeugt.
- Neue API-Tests müssen auch gegen den lokalen Mock laufen (`bun run test:api:mock`). Fehlende Testdaten unter odata/mock/data ergänzen.

## Lagerautomatik (Mock PLC, MFS)

- Tests, die Fördertechnik, Regalbediengeräte oder I-Punkt brauchen, importieren `test` und `expect` aus '../../sap-plugin/mfs'. Die SAP-Locators bleiben verfügbar.
- Abläufe der Automatik nur mit `await mfs.runScenario(name)` (Datei in mfs/scenarios) oder einem im Test geschriebenen Szenario, nicht mit selbst gebauten Aufrufen der Steuer-API. Jeder Szenarioschritt erscheint als Schritt im Bericht.
- Das Ergebnis enthält die HU-Nummern (`result.hus.A`). Damit in EWM prüfen, was aus den HUs wurde (Lagertask quittiert, Bestand im Platz).
- Ohne Mock PLC (MFS_EMULATOR_URL, ggf. MFS_EMULATOR_TOKEN) werden diese Tests übersprungen. Lokal und in CI startet `bun run test:mfs` (MFS_MOCK=1) eine Mock PLC mit simuliertem EWM.
- Szenarien mit `"modes": ["demo"]` laufen nur mit dem simulierten EWM. Gegen ein echtes EWM nur Szenarien mit "ewm" in `modes`.
- Negativfälle mit `{ expectPass: false }` und dem zurückgegebenen Ergebnis prüfen, nicht mit try/catch.

## IDoc-Tests

- Tests, die von SAP gesendete IDocs prüfen, importieren `test` und `expect` aus '../../sap-plugin/idoc'. OData-Fixtures und SAP-Locators bleiben verfügbar.
- Auf das IDoc mit `idocInbox.waitFor({ partner, messageType })` warten, nicht mit festen Wartezeiten. Mit `where` auf etwas Eindeutiges des Tests einschränken, z. B. die Belegnummer aus der Erfolgsmeldung: Der Empfänger wird geteilt.
- Fehlerfälle mit `idocInbox.reply(partner, { mode: 'reject' })` oder `{ mode: 'slow', delayMs }` testen und danach den IDoc-Status in SAP prüfen. Die Antwort gilt nur bis zum Ende des Tests.
- Neue IDoc-Tests müssen auch gegen den lokalen Empfänger laufen (`bun run test:idoc`).

## Was abgedeckt sein muss

Jeder kritische Geschäftsablauf braucht Tests für diese Fälle. Beim Schreiben eines Tests prüfen, welche Fälle für den Ablauf noch fehlen, und sie melden.

1. Smoke: Anmeldung je Testbenutzer, Launchpad lädt, jede kritische App und Transaktion öffnet ihr erstes Bild.
2. Prozesskette statt Einzelbild: z. B. Auftrag → Lieferung → Warenausgang → Faktura oder Bestellanforderung → Bestellung → Wareneingang → Rechnung. Belegnummer aus der Erfolgsmeldung lesen, den Beleg in der Anzeige öffnen (VA03, ME23N) und Belegfluss und gespeicherte Werte prüfen.
3. Berechtigungen: Ein Benutzer mit der Rolle kann den Schritt ausführen, ein Benutzer ohne sie erhält eine Berechtigungsmeldung. Je Rolle mindestens zwei Testbenutzer.
4. Negativfälle: Pflichtfeld leer, ungültiger Wert, gesperrter Kunde oder Lieferant, Kreditlimit überschritten, Material nicht im Werk angelegt, kein Bestand. Den Meldungstyp prüfen (E/W/S in der WebGUI-Statusleiste, MessageStrip oder MessageBox in Fiori), wenn möglich die Meldungsnummer statt des Texts.
5. Benutzereinstellungen: Datums- und Zahlenformat aus SU01, Währungen mit 0 oder 3 Nachkommastellen (JPY, KWD), Mengeneinheiten, Anmeldesprache.
6. Sperren und Entwürfe: Eine zweite Sitzung auf demselben Objekt erhält "gesperrt durch Benutzer …". In Fiori Elements: Entwurf anlegen, verwerfen, fortsetzen und von einem anderen Benutzer gesperrt; der Hinweis auf ungesicherte Änderungen (`page.ui5HasPendingChanges`).
7. OData: Ein Changeset im `$batch` ist atomar (schlägt eine Operation fehl, wird keine ausgeführt), ein veraltetes ETag liefert 412, Fehlerantworten haben das erwartete Format, `$filter` und `$expand` mit leerem Ergebnis, Paging mit `$top` und `$skip`.
8. Zeitabhängiges: geschlossene Buchungsperiode, Geschäftsjahreswechsel, Fabrikkalender, Gültigkeit von Preisen und Konditionen. Datumswerte im Test ausdrücklich setzen, nicht vom Lauftag abhängen.
9. Asynchrone Schritte: IDoc (tRFC mit SNC), Ausgabe (Druck, E-Mail), Workflow-Freigaben, Hintergrundjobs. Auf den Status warten (z. B. IDoc-Status 53, Workitem erledigt).

Die meisten SAP-Belege lassen sich nicht löschen, nur stornieren. `undo` in `cleanup` storniert dann den Beleg (z. B. VF11, MBST, FB08). Solche Tests laufen nur im Testmandanten mit eigenen Nummernkreisen.

## Beim Reparieren eines fehlgeschlagenen Tests

- Zuerst den Trace öffnen und die Ursache nennen, dann Code ändern.
- Liegt der Fehler in der Anwendung: melden, den Test nicht ändern.
- SAP-Locators beibehalten. Nicht auf Standard-Locators ausweichen.

## Was der Linter prüft

`bun run lint` schlägt bei diesen Regeln fehl. Die Test-App zeigt verwandte Befunde je Test an, erkennt Passwörter aber etwas anders (siehe tools/oxlint/sap-rules/README.md): Ein Befund kann in nur einem der beiden Werkzeuge erscheinen.

- `waitForTimeout` (feste Wartezeit).
- `test` oder `expect` aus '@playwright/test' in einer Datei unter tests/. Typen und andere Exporte (z. B. `chromium`) sind erlaubt.
- `fill`, `type` oder `pressSequentially` auf einem Passwortfeld oder mit einem Passwort als Wert (`sap/no-secret-fill`), auch als `page.fill(selektor, wert)`.
- Ein in den Code geschriebenes Passwort bei `fillSecret` oder `page.SAPLogin`, auch über eine Konstante (`sap/no-literal-secret`).

Die beiden Passwortregeln erkennen Passwörter am Namen (Beschriftung des Felds, Name der Variable). Ein Passwortfeld mit anderem Namen erkennen sie nicht, und ein Feld, das nur „Password“ im Namen trägt (z. B. „Password policy“), halten sie für eines; dann die Zeile mit `// oxlint-disable-next-line sap/no-secret-fill -- <Grund>` ausnehmen. Außerdem gilt: `fillSecret` selbst prüft beim Lauf, dass das Feld ein Passwortfeld ist. Alle anderen Regeln dieser Datei prüft kein Werkzeug.

## KI-Rollen (Planner, Generator, Healer)

- Die drei Rollen liegen in .claude/agents/playwright-test-*.md (aus `playwright init-agents` erzeugt und um diese Regeln ergänzt). Sie arbeiten über den MCP-Server playwright-test aus .mcp.json.
- Pläne der Rolle Planner liegen in specs/. Eine Person prüft den Plan, bevor daraus Code entsteht.
- Startpunkt der Rollen ist tests/_agents/seed.spec.ts (leere Seite) oder tests/_agents/seed-signed-in.spec.ts (als Projekt die id des Systems aus systems.json, z. B. sap: startet mit dessen Sitzung aus setup/sign-in.setup.ts). Beide importieren aus sap-plugin, damit die SAP-Locators im Browser der Rollen funktionieren.
- Die Rolle Healer führt eigene Korrekturen nicht zusammen. Jeder von der KI geschriebene oder reparierte Test wird von einer Person geprüft; dabei kontrollieren, dass keine Prüfung entfernt oder gelockert wurde.

## Kennzeichnung

- Neue Tests erhalten den Kommentar "// KI-generiert, geprüft von: <Name>".
