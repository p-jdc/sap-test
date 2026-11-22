# Shopping Cart: checkout edge cases

## Application Overview

Edge cases of the checkout wizard of SAP's public UI5 demo kit app "Shopping Cart" (sap.m cart demo) that sap-tests/specs/shopping-cart-checkout.plan.md does not cover: (1) changing the payment type after the credit card step was completed ("Warning" dialog, "No" and "Yes"), (2) validation of the step "Details for Cash on Delivery". Explored on 2026-11-22 with the playwright-test MCP server (planner agent). The app runs on mock data, nothing real changes; every test starts with an empty cart.

**Address:** `https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html?sap-ui-theme=sap_horizon_dark` (no login; needs internet access). The checkout is at `#/checkout`. Wizard structure, general pitfalls (hidden twin controls, MaskInput needs fill(), validate on Tab, `text` matches as a substring) are in the overview of the existing plan and apply here as well. The way into the checkout (steps 1 to 6 of every scenario below) is the one of the existing tests: reuse the `openCart` helper from `sap-tests/helpers/cart-demo.ts` and `button`, `fillAndLeave`, `visible` from `sap-tests/helpers/fiori.ts`.

**Behaviour found (all verified on the running app; scenarios 1.1 and 1.2 were each run end to end by hand, scenario 1.3 by field and value):**

- The "Warning" dialog (`Dialog`, title "Warning", type Message) appears only when the credit card step was already valid (progress beyond the step "Payment Type"). Changing the payment type before that (for example in the cash-on-delivery test) shows no dialog. Its text is "Are you sure you want to change the payment type? This will discard your progress." and it has two buttons, "Yes" and "No".
- The segmented button already shows the new choice while the dialog is open (`SegmentedButton, selectedKey "Cash on Delivery"`).
- **"No"**: the dialog closes; the wizard stays exactly where it was: step "Credit Card Details" is still shown with all four values ("Alex Example", "1234-5678-9012-3456", "123", "12/2030"), the button "Step 4" is still there, the wizard progress bar still lists Items, Payment Type, Credit Card Details, Invoice Address, and no step "Details for Cash on Delivery" exists. **Defect candidate:** the payment type is not set back. The segmented button (and, about one second after the click, the model's `/SelectedPayment`) shows "Cash on Delivery" although the wizard goes on with credit card steps. Directly after "No" the model value is briefly empty (null), then "Cash on Delivery". On the order summary this led to a payment section "Cash on Delivery" with empty first name, last name, phone and e-mail in one run, and to no payment section at all in another run (timing dependent). Scenario 1.1 therefore stops before the order summary and asserts the segmented button only in an optional, marked step.
- **"Yes"**: the dialog closes and the wizard is cut back to the step "Payment Type": the progress bar then lists only Items and Payment Type, the steps "Credit Card Details" and "Invoice Address" are not shown any more, the button "Step 3" is shown (not "Step 4" or "Step 5"). The segmented button shows "Cash on Delivery". "Step 3" opens "Details for Cash on Delivery" with all four fields empty and without an error, and without a visible "Step 4". The values typed earlier are not deleted: after the cash-on-delivery details are valid, "Step 4" opens "Invoice Address" with "Musterstrasse 1", "Walldorf", "69190", "Germany" still in the fields, and "Step 5" is visible at once. Switching back to "Credit Card" (another warning dialog, "Yes") also shows the card values again and "Step 4". "Discard your progress" thus means: the wizard steps after "Payment Type" are closed and must be confirmed again, entered values stay in the model.
- After the first visit of the credit card step a second, hidden "Step 4" button exists (the credit card step's own). After "Yes" and the cash-on-delivery step two buttons match `Button, text "Step 4"`; use `.filter({ visible: true })` for it in scenario 1.2, and for the "no Step 4" checks use `toBeHidden()`.
- The cart survives a page reload (it is stored by the app in the browser). Each Playwright test starts with a new browser context, so this does not matter for the tests; it did matter while exploring.

**Validation of "Details for Cash on Delivery" (scenario 1.3).** All four fields are `sap.m.Input`, validated when the field loses focus (Tab). The value is checked by the binding type; the button "Step 4" appears when all four values are valid and disappears as soon as one is not.

| Field (placeholder)                  | Rejected                                                                                                                                                        | Accepted                                                                                                                                 | valueStateText on error                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| First name ("Enter your first name") | empty, "A"                                                                                                                                                      | "Al", "Alex", "123", two blanks                                                                                                          | `Enter a value with at least 2 characters`                                                          |
| Last name ("Enter your last name")   | empty, "E"                                                                                                                                                      | "Ex", "Example"                                                                                                                          | `Enter a value with at least 2 characters`                                                          |
| Phone ("Enter your phone number")    | empty, "1", "abc", "12a", "a12", "1-2", "12.34", "+49 (0) 6227", "(06227) 12-34/56", "++--"                                                                     | "12", "+12", "1 2", "+49 6227 000000", "00 49 6227 000000", "06227000000", 40 digits                                                     | `Enter a valid value`                                                                               |
| E-mail ("Enter your email address")  | empty, "notanemail", "a@b", "a@b.c", "@b.com", ".a@b.de", "a b@c.de", "a@b..de", "a@@b.de", "a@b.de.", "a@b.c0", "ä@b.de", "alex@example.com " (trailing blank) | "a@b.co", "alex@example.com", "alex.example@example.com", "a.b@c.de", "a+b@c.de", "a-b@c-d.de", "UPPER@EXAMPLE.COM", "a@sub.example.com" | `"<the entered value>" is not a valid email address` (with straight double quotes around the value) |

So the e-mail field does check the format (a local part, "@", a domain and a top-level domain of at least two letters); the demo does not check names for letters (digits and blanks pass), and the phone check is loose ("++12" passes). Not asserted by any scenario, only listed as gaps. A field that is only focused and left empty without ever having a value shows no error. After typing a wrong value and then Tab, the error state appears a moment later; reading the state right after Tab gave stale results. Always assert with an auto-retrying `expect(locator).toBeVisible()` on the SAP locator that carries `valueState` and `valueStateText`, never read the property once.

**Locators verified (count 1 unless stated):** `Dialog, title "Warning"`; `Text, text "Are you sure you want to change the payment type? This will discard your progress."`; `Button, text "Yes"` and `Button, text "No"` (exact) while the dialog is open (also 1 without exact for both); `Button, text "Cash on Delivery"` and `Button, text "Credit Card"` (only 1 each, they are buttons of the segmented button); `SegmentedButton, selectedKey "Cash on Delivery"` / `"Credit Card"`; `WizardStep, title "Credit Card Details"` / `"Details for Cash on Delivery"` / `"Invoice Address"` / `"Payment Type"` (steps that are not shown still exist, so "is shown" means `.filter({ visible: true })`, "is not shown" means `toBeHidden()`); the four cash-on-delivery inputs by placeholder (1 each, also visible-only 1); `Input, placeholder "Enter your email address", valueState "Error", valueStateText '"a@b" is not a valid email address'` (1); `Button, text "Step 3"` (1 in total, visible-only 1 after "Yes"); `Button, text "Step 4"` (1 or 2 in total, see above; visible-only 0 or 1). Controls without a unique SAP locator: none, but the wizard progress bar (Items, Payment Type, ...) has no UI5 control of its own that was checked; scenarios use the step titles instead of it.

**Not explored:** Bank Transfer as the new payment type (button "Bank Transfer" shows the same dialog; what "Yes" does there was not checked); changing the payment type after the invoice or delivery step with a different shipping address; the order summary after "No" (timing dependent, see above); "Yes" on the dialog opened from a later step than the credit card step.

## Test Scenarios

### 1. Shopping Cart checkout edge cases

**Seed:** `sap-tests/tests/_agents/seed.spec.ts`

#### 1.1. demo kit: "No" on the payment type warning keeps the credit card details

**File:** `sap-tests/tests/fiori/demokit/shopping-cart-checkout-payment-change-no.spec.ts`

**Steps:**

1. Open the address from the overview - expect: StandardListItem, title "Laptops" is visible
2. Click StandardListItem, title "Laptops"
3. Click Text, text "Notebook Basic 17" - expect: ObjectHeader, title "Notebook Basic 17" is visible
4. Open the cart with the openCart helper - expect: Title, text "Shopping Cart" (exact) is visible
5. Click Button, text "Add to Cart" - expect: ObjectListItem, intro "1 x" is visible - expect: Text, text "Total: 1.249,00 EUR" is visible
6. Click Button, text "Proceed" - expect: Page, title "Checkout" is visible - expect: WizardStep, title "Items" is visible
7. Click Button, text "Step 2", then Button, text "Step 3" - expect: WizardStep, title "Credit Card Details" is visible - expect: Button, text "Step 4" is hidden
8. With fillAndLeave (fill, then Tab) fill Input, placeholder "Enter card holder name" with "Alex Example"; MaskInput, placeholder "Enter card number" with "1234567890123456"; MaskInput, placeholder "Enter the 3-digits security number" with "123"; DatePicker (the only one) with "12/2030" - expect: Button, text "Step 4" is visible
9. Click Button, text "Cash on Delivery" (it is in the step "Payment Type" above) - expect: Dialog, title "Warning" is visible - expect: Text, text "Are you sure you want to change the payment type? This will discard your progress." is visible - expect: Button, text "Yes" (exact) is visible and Button, text "No" (exact) is visible
10. Click Button, text "No" (exact) - expect: Dialog, title "Warning" is hidden
11. Check that the wizard did not change - expect: WizardStep, title "Credit Card Details" (visible only) is visible - expect: WizardStep, title "Details for Cash on Delivery" (visible only) is hidden - expect: Input, placeholder "Enter card holder name" has value "Alex Example" - expect: MaskInput, placeholder "Enter card number" has value "1234-5678-9012-3456" - expect: MaskInput, placeholder "Enter the 3-digits security number" has value "123" - expect: DatePicker has value "12/2030" - expect: Button, text "Step 4" (visible only) is visible
12. OPTIONAL, defect candidate, ask the reviewer whether to keep it: check the segmented button (waits up to one second, use the auto-retrying expect) - expect: SegmentedButton, selectedKey "Cash on Delivery" is visible although the wizard still shows the credit card step. A user would expect "Credit Card" here; if the reviewer wants that expectation instead, write the step as it should be and mark the test test.fail() with a comment. Report the defect either way.
13. Click Button, text "Step 4" (visible only) - expect: WizardStep, title "Invoice Address" (visible only) is visible - expect: WizardStep, title "Details for Cash on Delivery" (visible only) is still hidden - expect: Do not go on to the order summary: its payment section after "No" depends on timing

#### 1.2. demo kit: "Yes" on the payment type warning cuts the wizard back to the payment type

**File:** `sap-tests/tests/fiori/demokit/shopping-cart-checkout-payment-change-yes.spec.ts`

**Steps:**

1. Open the address from the overview - expect: StandardListItem, title "Laptops" is visible
2. Click StandardListItem, title "Laptops"
3. Click Text, text "Notebook Basic 17" - expect: ObjectHeader, title "Notebook Basic 17" is visible
4. Open the cart with the openCart helper - expect: Title, text "Shopping Cart" (exact) is visible
5. Click Button, text "Add to Cart" - expect: ObjectListItem, intro "1 x" is visible - expect: Text, text "Total: 1.249,00 EUR" is visible
6. Click Button, text "Proceed" - expect: Page, title "Checkout" is visible - expect: WizardStep, title "Items" is visible
7. Click Button, text "Step 2", then Button, text "Step 3" - expect: WizardStep, title "Credit Card Details" is visible
8. With fillAndLeave fill Input, placeholder "Enter card holder name" with "Alex Example"; MaskInput, placeholder "Enter card number" with "1234567890123456"; MaskInput, placeholder "Enter the 3-digits security number" with "123"; DatePicker with "12/2030" - expect: Button, text "Step 4" is visible
9. Click Button, text "Step 4", then fill Input (visible only) placeholder "Enter your street name and house number" with "Musterstrasse 1"; "Enter your city" with "Walldorf"; "Enter your zip code" with "69190"; "Enter your country" with "Germany" (Tab after each) - expect: WizardStep, title "Invoice Address" is visible - expect: Button, text "Step 5" is visible
10. Click Button, text "Cash on Delivery" in the step "Payment Type" - expect: Dialog, title "Warning" is visible - expect: Text, text "Are you sure you want to change the payment type? This will discard your progress." is visible
11. Click Button, text "Yes" (exact) - expect: Dialog, title "Warning" is hidden - expect: SegmentedButton, selectedKey "Cash on Delivery" is visible - expect: Button, text "Step 3" (visible only) is visible - expect: WizardStep, title "Payment Type" (visible only) is visible - expect: WizardStep, title "Credit Card Details" (visible only) is hidden - expect: WizardStep, title "Invoice Address" (visible only) is hidden - expect: Button, text "Step 4" (visible only) is hidden - expect: Button, text "Step 5" (visible only) is hidden
12. Click Button, text "Step 3" (visible only) - expect: WizardStep, title "Details for Cash on Delivery" (visible only) is visible - expect: Button, text "Step 4" (visible only) is hidden - expect: Input, placeholder "Enter your first name" has value "" and Input, placeholder "Enter your first name", valueState "Error" is hidden
13. With fillAndLeave fill Input, placeholder "Enter your first name" with "Alex"; "Enter your last name" with "Example"; "Enter your phone number" with "+49 6227 000000"; "Enter your email address" with "alex.example@example.com" - expect: Button, text "Step 4" (visible only) is visible
14. Click Button, text "Step 4" (visible only) - expect: WizardStep, title "Invoice Address" (visible only) is visible - expect: The four visible address inputs still hold "Musterstrasse 1", "Walldorf", "69190", "Germany" (the discarded progress did not delete the values) - expect: Button, text "Step 5" (visible only) is visible without typing anything

#### 1.3. demo kit: the cash on delivery step only lets valid details through

**File:** `sap-tests/tests/fiori/demokit/shopping-cart-checkout-cash-on-delivery-validation.spec.ts`

**Steps:**

1. Open the address from the overview - expect: StandardListItem, title "Laptops" is visible
2. Click StandardListItem, title "Laptops"
3. Click Text, text "Notebook Basic 17" - expect: ObjectHeader, title "Notebook Basic 17" is visible
4. Open the cart with the openCart helper - expect: Title, text "Shopping Cart" (exact) is visible
5. Click Button, text "Add to Cart" - expect: ObjectListItem, intro "1 x" is visible - expect: Text, text "Total: 1.249,00 EUR" is visible
6. Click Button, text "Proceed" - expect: Page, title "Checkout" is visible - expect: WizardStep, title "Items" is visible
7. Click Button, text "Step 2", then Button, text "Cash on Delivery" (no warning dialog appears yet), then Button, text "Step 3" - expect: WizardStep, title "Details for Cash on Delivery" is visible - expect: Button, text "Step 4" (visible only) is hidden - expect: Input, valueState "Error" is hidden: untouched fields show no error
8. Fill the four fields with valid values (first name "Alex", last name "Example", phone "+49 6227 000000", e-mail "alex.example@example.com"), each with fillAndLeave - expect: Button, text "Step 4" (visible only) is visible - expect: Input, valueState "Error" is hidden
9. Fill first name with "A", then Tab - expect: Input, placeholder "Enter your first name", valueState "Error", valueStateText "Enter a value with at least 2 characters" is visible (auto-retrying) - expect: Button, text "Step 4" (visible only) is hidden
10. Fill first name with "Al", then Tab - expect: Input, placeholder "Enter your first name", valueState "None" is visible - expect: Button, text "Step 4" (visible only) is visible
11. Fill last name with "E", then Tab - expect: Input, placeholder "Enter your last name", valueState "Error", valueStateText "Enter a value with at least 2 characters" is visible - expect: Button, text "Step 4" (visible only) is hidden
12. Fill last name with "Ex", then Tab - expect: Input, placeholder "Enter your last name", valueState "None" is visible - expect: Button, text "Step 4" (visible only) is visible
13. Fill phone number with "abc", then Tab - expect: Input, placeholder "Enter your phone number", valueState "Error", valueStateText "Enter a valid value" is visible - expect: Button, text "Step 4" (visible only) is hidden
14. Fill phone number with "1", then Tab - expect: same error state and message "Enter a valid value"; Button, text "Step 4" (visible only) is hidden
15. Fill phone number with "12", then Tab - expect: Input, placeholder "Enter your phone number", valueState "None" is visible - expect: Button, text "Step 4" (visible only) is visible
16. Fill e-mail with "notanemail", then Tab - expect: Input, placeholder "Enter your email address", valueState "Error", valueStateText '"notanemail" is not a valid email address' is visible - expect: Button, text "Step 4" (visible only) is hidden
17. Fill e-mail with "a@b", then Tab - expect: same locator with valueStateText '"a@b" is not a valid email address' is visible; Button, text "Step 4" (visible only) is hidden
18. Fill e-mail with "a@b.c" (top-level domain of one letter), then Tab - expect: valueStateText '"a@b.c" is not a valid email address' is visible; Button, text "Step 4" (visible only) is hidden
19. Fill e-mail with "a@b.co", then Tab - expect: Input, placeholder "Enter your email address", valueState "None" is visible - expect: Button, text "Step 4" (visible only) is visible
20. Clear the first name (fill with an empty string, Tab) - expect: Input, placeholder "Enter your first name", valueState "Error", valueStateText "Enter a value with at least 2 characters" is visible - expect: Button, text "Step 4" (visible only) is hidden
21. Fill first name "Alex", last name "Example", phone "+49 6227 000000", e-mail "alex.example@example.com" again (fillAndLeave) - expect: All four inputs have valueState "None" (assert each with an auto-retrying expect) - expect: Button, text "Step 4" (visible only) is visible
22. Click Button, text "Step 4" (visible only) - expect: WizardStep, title "Invoice Address" (visible only) is visible
