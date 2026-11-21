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

## Beim Reparieren eines fehlgeschlagenen Tests

- Zuerst den Trace öffnen und die Ursache nennen, dann Code ändern.
- Liegt der Fehler in der Anwendung: melden, den Test nicht ändern.
- SAP-Locators beibehalten. Nicht auf Standard-Locators ausweichen.

## Kennzeichnung

- Neue Tests erhalten den Kommentar "// KI-generiert, geprüft von: <Name>".
