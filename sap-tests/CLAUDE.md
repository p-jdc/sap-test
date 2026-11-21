# Regeln für SAP-Tests

Dieses Projekt nutzt Standard-Playwright mit dem SAP-Plugin in sap-plugin/ (Locators aus Playwright-SAP). Tests importieren `test` und `expect` aus sap-plugin (z. B. '../../sap-plugin'), nicht aus '@playwright/test'.
Playwright-SAP selbst liegt nur noch in recorder/ und dient ausschließlich dem Aufzeichnen.
Neue Tests folgen dem Aufbau von tests/_reference/gold-standard.spec.ts.

## Locators in dieser Reihenfolge

1. Fiori/UI5: page.getByRoleUI5(controlType, { eineEigenschaft }). Es wird nur eine Eigenschaft je Aufruf unterstützt.
2. WebGUI: page.getByRoleSID(role, { name, pos, sub, wnd }). Für Tabellenzellen und eigene Controls: page.locateSID('<vollständiger SID-Pfad>').
3. Ariba und Nicht-SAP-Seiten: getByRole, getByLabel, getByText.

Auf SAP-Bildschirmen nie CSS-Selektoren, XPath oder generierte IDs. .nth() nur, wenn keine Eigenschaft das Control eindeutig bestimmt.

## Aufbau

- Hilfsfunktionen aus helpers/ verwenden, wenn es eine passende gibt.
- Anmeldung mit page.SAPLogin und Umgebungsvariablen.
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

## Beim Reparieren eines fehlgeschlagenen Tests

- Zuerst den Trace öffnen und die Ursache nennen, dann Code ändern.
- Liegt der Fehler in der Anwendung: melden, den Test nicht ändern.
- SAP-Locators beibehalten. Nicht auf Standard-Locators ausweichen.

## Kennzeichnung

- Neue Tests erhalten den Kommentar "// KI-generiert, geprüft von: <Name>".
