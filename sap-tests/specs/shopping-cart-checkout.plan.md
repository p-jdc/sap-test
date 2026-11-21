# Shopping Cart: checkout

## Application Overview

Complete checkout of SAP's public UI5 demo kit app "Shopping Cart" (sap.m cart demo), from an empty cart to the order confirmation. Explored on 2026-11-21 through the Playwright test MCP server, by hand, and corrected after scenario 1.1 was written and run (not by the planner agent, whose MCP server was not connected in that session). The app runs on mock data: submitting an order changes nothing real, and every test starts with an empty cart.

**Address:** `https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html?sap-ui-theme=sap_horizon_dark` (no login; needs internet access). The checkout is at `#/checkout`, the confirmation at `#/ordercompleted`.

**Already covered** in `sap-tests/tests/fiori/demokit/shopping-cart.spec.ts` and not planned again: browsing a category and adding a product, searching, starting the checkout up to the wizard step "Items", removing a product in edit mode. Reuse that file's `openCart` helper and its way into the cart.

**The wizard.** Steps appear one at a time. Each step ends with an emphasized button "Step N" (N = number of the next step), which only exists while the current step is valid; the last step ends with "Order Summary". The step sequence depends on the choices:

- Credit Card: Items, Payment Type, Credit Card Details, Invoice Address, Delivery Type (5 steps)
- Bank Transfer: Items, Payment Type, Bank Account Details (read-only, no input), Invoice Address, Delivery Type
- Cash on Delivery: Items, Payment Type, Details for Cash on Delivery, Invoice Address, Delivery Type
- Ticking "Use Different Address for Delivery" in Invoice Address adds a step "Shipping Address" before Delivery Type, so Delivery Type is then reached with "Step 6".

**Locators and pitfalls found while exploring** (each locator below was checked on the running app):

- Every control named in a step is given as `ControlType, property "value"` for `page.getByRoleUI5`.
- Controls of views and steps that are not shown stay in the page. Where a step says "visible only", add `.filter({ visible: true })`, otherwise the locator matches more than one control. This applies to the four address inputs (they exist for the invoice and for the shipping address), to `ObjectListItem, title "Notebook Basic 17"` (4 matches), to `Text, text "Total: 0,00 EUR"` (2) and to `Button, text "Return to Shop"` (2).
- On the step "Shipping Address" both address forms are visible. The shipping inputs are the last of the two visible matches (`.filter({ visible: true }).last()`).
- `text` matches as a part of the value: `Text, text "Credit Card"` also matches longer texts, and `Text, text "Standard Delivery"` also matches the info text of the delivery step ("Standard delivery time is 5 workdays…"). Pass `{ exact: true }` for both.
- The card number and the security code are `MaskInput` controls (masks `CCCC-CCCC-CCCC-CCCC` and `CCC`, digits only). `fill()` with the bare digits works and the field adds the dashes. Clicking the field and typing on the keyboard loses the first digit; do not use the `typeInto` helper here.
- A field is validated when it loses focus: press Tab after each `fill()`.
- The confirmation text is one `FormattedText` control. `getByRoleUI5` resolves it (and the `Page` around it) to the link inside the text, so read it with `page.locateUI5Control({ controlType: 'sap.m.FormattedText', interaction: 'root' })` and `toContainText`.
- The order summary page has no page title. Recognise it by `Button, text "Submit"` or `Title, text "Credit Card Payment"`.

**Behaviour worth knowing**

- The expiration date is not validated: a date in the past (01/2020) is accepted and the wizard goes on. This looks like a gap in the demo app; scenario 3 does not assert it either way.
- After correcting an invalid security code, the field kept its error state once although the step was already valid. Scenario 3 therefore asserts error states only while values are invalid, and the "Step 4" button for validity.
- The total stays "Total: 1.249,00 EUR" for every payment and delivery type; the fees named in the texts are not added.
- The order number on the confirmation was 20171941 in the one run that was submitted. Whether it is the same in every run was not checked; assert the text "Your order number:", not the number.

**Open point for scenario 3:** the error states were read from the controls (`getValueState()`, `getValueStateText()`) with a script in the page. The message text was not found in the page while the field had no focus, and how a test should assert the error state (focus the field and check the message popup, or check the input's `aria-invalid`) was not tried. The generator has to work that out on the running app.

**Not explored:** submitting an order paid by Cash on Delivery (scenario 2 was explored up to the order summary; the submit steps are taken from scenario 1), the Bank Transfer path beyond its step 3, the "Note" fields, the edit buttons on the order summary, and "No" in the two dialogs.

## Test Scenarios

### 1. Shopping Cart checkout

**Seed:** `sap-tests/tests/_agents/seed.spec.ts`

#### 1.1. demo kit: check out with credit card and standard delivery

**File:** `sap-tests/tests/fiori/demokit/shopping-cart-checkout-credit-card.spec.ts`

**Steps:**

1. Open the address above - expect: StandardListItem, title "Laptops" is visible
2. Open the category: click StandardListItem, title "Laptops"
3. Open the product: click Text, text "Notebook Basic 17" - expect: ObjectHeader, title "Notebook Basic 17" is visible
4. Open the cart with the existing openCart helper (ToggleButton, icon "sap-icon://cart", visible only, wait until exactly one is left) - expect: Title, text "Shopping Cart" (exact) is visible
5. Click Button, text "Add to Cart" - expect: ObjectListItem, intro "1 x" is visible - expect: Text, text "Total: 1.249,00 EUR" is visible
6. Click Button, text "Proceed" - expect: Page, title "Checkout" is visible - expect: WizardStep, title "Items" is visible
7. Click Button, text "Step 2" - expect: WizardStep, title "Payment Type" is visible - expect: SegmentedButton has selectedKey "Credit Card" (preselected)
8. Click Button, text "Step 3" - expect: WizardStep, title "Credit Card Details" is visible - expect: There is no Button, text "Step 4" yet
9. Fill Input, placeholder "Enter card holder name" with "Alex Example", then press Tab
10. Fill MaskInput, placeholder "Enter card number" with "1234567890123456", then press Tab - expect: The field shows "1234-5678-9012-3456"
11. Fill MaskInput, placeholder "Enter the 3-digits security number" with "123", then press Tab
12. Fill the DatePicker (the only one in the app) with "12/2030", then press Tab - expect: Button, text "Step 4" is visible
13. Click Button, text "Step 4" - expect: WizardStep, title "Invoice Address" is visible
14. Fill Input, placeholder "Enter your street name and house number" (visible only) with "Musterstrasse 1", then press Tab
15. Fill Input, placeholder "Enter your city" (visible only) with "Walldorf", then press Tab
16. Fill Input, placeholder "Enter your zip code" (visible only) with "69190", then press Tab
17. Fill Input, placeholder "Enter your country" (visible only) with "Germany", then press Tab - expect: Button, text "Step 5" is visible
18. Click Button, text "Step 5" - expect: WizardStep, title "Delivery Type" is visible - expect: SegmentedButton has selectedKey "Standard Delivery" (preselected)
19. Click Button, text "Order Summary" - expect: Button, text "Submit" is visible - expect: Title, text "Total: 1.249,00 EUR" is visible - expect: Text, text "Credit Card" (exact) is visible - expect: Title, text "Credit Card Payment" is visible - expect: Text, text "Alex Example" is visible - expect: Text, text "1234-5678-9012-3456" is visible - expect: Text, text "12/2030" is visible - expect: Text, text "Musterstrasse 1" is visible - expect: Text, text "Walldorf" is visible - expect: Text, text "Standard Delivery" (exact) is visible - expect: Text, text "Same as invoice address" is visible
20. Click Button, text "Submit" - expect: Dialog, title "Confirmation" is visible - expect: Text, text "Are you sure you want to submit your order?" is visible
21. Click Button, text "Yes" - expect: Page, title "Order Completed" is visible - expect: The confirmation text contains "Thank you for your order!" - expect: The confirmation text contains "Your order number:" - expect: The confirmation text contains "You will receive an e-mail confirmation shortly."
22. Click Button, text "Return to Shop" (visible only), then open the cart with the openCart helper - expect: Text, text "Total: 0,00 EUR" (visible only) is visible - expect: Button, text "Proceed" is disabled

#### 1.2. demo kit: check out with cash on delivery, a different shipping address and express delivery

**File:** `sap-tests/tests/fiori/demokit/shopping-cart-checkout-cash-on-delivery.spec.ts`

**Steps:**

1. Open the address above - expect: StandardListItem, title "Laptops" is visible
2. Open the category: click StandardListItem, title "Laptops"
3. Open the product: click Text, text "Notebook Basic 17" - expect: ObjectHeader, title "Notebook Basic 17" is visible
4. Open the cart with the existing openCart helper (ToggleButton, icon "sap-icon://cart", visible only, wait until exactly one is left) - expect: Title, text "Shopping Cart" (exact) is visible
5. Click Button, text "Add to Cart" - expect: ObjectListItem, intro "1 x" is visible - expect: Text, text "Total: 1.249,00 EUR" is visible
6. Click Button, text "Proceed" - expect: Page, title "Checkout" is visible - expect: WizardStep, title "Items" is visible
7. Click Button, text "Step 2" - expect: WizardStep, title "Payment Type" is visible
8. Click Button, text "Cash on Delivery" - expect: SegmentedButton has selectedKey "Cash on Delivery"
9. Click Button, text "Step 3" - expect: WizardStep, title "Details for Cash on Delivery" is visible - expect: There is no Button, text "Step 4" yet
10. Fill Input, placeholder "Enter your first name" with "Alex", then press Tab
11. Fill Input, placeholder "Enter your last name" with "Example", then press Tab
12. Fill Input, placeholder "Enter your phone number" with "+49 6227 000000", then press Tab
13. Fill Input, placeholder "Enter your email address" with "alex.example@example.com", then press Tab - expect: Button, text "Step 4" is visible
14. Click Button, text "Step 4" - expect: WizardStep, title "Invoice Address" is visible
15. Tick the CheckBox (the only one in the app; its label is "Use Different Address for Delivery")
16. Fill Input, placeholder "Enter your street name and house number" (visible only) with "Musterstrasse 1", then press Tab
17. Fill Input, placeholder "Enter your city" (visible only) with "Walldorf", then press Tab
18. Fill Input, placeholder "Enter your zip code" (visible only) with "69190", then press Tab
19. Fill Input, placeholder "Enter your country" (visible only) with "Germany", then press Tab - expect: Button, text "Step 5" is visible
20. Click Button, text "Step 5" - expect: WizardStep, title "Shipping Address" is visible - expect: There is no Button, text "Step 6" yet
21. Fill the shipping address, each time the last visible match: Input, placeholder "Enter your street name and house number" with "Beispielweg 2"; "Enter your city" with "Heidelberg"; "Enter your zip code" with "69115"; "Enter your country" with "Germany". Press Tab after each - expect: Button, text "Step 6" is visible
22. Click Button, text "Step 6" - expect: WizardStep, title "Delivery Type" is visible
23. Click Button, text "Express" - expect: SegmentedButton has selectedKey "Express Delivery"
24. Click Button, text "Order Summary" - expect: Button, text "Submit" is visible - expect: Title, text "Cash on Delivery" is visible - expect: Text, text "alex.example@example.com" is visible - expect: Text, text "+49 6227 000000" is visible - expect: Text, text "Musterstrasse 1" is visible - expect: Text, text "Express Delivery" is visible - expect: Text, text "Beispielweg 2" is visible - expect: Text, text "Heidelberg" is visible - expect: There is no Text, text "Same as invoice address" (visible only)
25. Click Button, text "Submit" - expect: Dialog, title "Confirmation" is visible - expect: Text, text "Are you sure you want to submit your order?" is visible
26. Click Button, text "Yes" - expect: Page, title "Order Completed" is visible - expect: The confirmation text contains "Thank you for your order!" - expect: The confirmation text contains "Your order number:" - expect: The confirmation text contains "You will receive an e-mail confirmation shortly."

#### 1.3. demo kit: the credit card step only lets valid details through

**File:** `sap-tests/tests/fiori/demokit/shopping-cart-checkout-validation.spec.ts`

**Steps:**

1. Open the address above - expect: StandardListItem, title "Laptops" is visible
2. Open the category: click StandardListItem, title "Laptops"
3. Open the product: click Text, text "Notebook Basic 17" - expect: ObjectHeader, title "Notebook Basic 17" is visible
4. Open the cart with the existing openCart helper (ToggleButton, icon "sap-icon://cart", visible only, wait until exactly one is left) - expect: Title, text "Shopping Cart" (exact) is visible
5. Click Button, text "Add to Cart" - expect: ObjectListItem, intro "1 x" is visible - expect: Text, text "Total: 1.249,00 EUR" is visible
6. Click Button, text "Proceed" - expect: Page, title "Checkout" is visible - expect: WizardStep, title "Items" is visible
7. Click Button, text "Step 2", then Button, text "Step 3" - expect: WizardStep, title "Credit Card Details" is visible - expect: There is no Button, text "Step 4"
8. Fill Input, placeholder "Enter card holder name" with "Al", then press Tab - expect: The control has valueState "Error" and valueStateText "Enter a value with at least 3 characters"
9. Fill MaskInput, placeholder "Enter card number" with "1234", then press Tab - expect: The field shows "1234-****-****-____" and is in error state with the message "Enter a valid value"
10. Fill MaskInput, placeholder "Enter the 3-digits security number" with "1", then press Tab - expect: The field is in error state with the message "Enter a valid value" - expect: There is no Button, text "Step 4"
11. Correct the three fields: "Alex Example", "1234567890123456", "123", each followed by Tab; fill the DatePicker with "12/2030" and press Tab - expect: Button, text "Step 4" is visible
12. Clear Input, placeholder "Enter card holder name" (fill with "") and press Tab - expect: Button, text "Step 4" is gone
13. Fill it with "Alex Example" again and press Tab - expect: Button, text "Step 4" is visible
14. Click Button, text "Cash on Delivery" in the step "Payment Type" - expect: Dialog, title "Warning" is visible - expect: Text, text "Are you sure you want to change the payment type? This will discard your progress." is visible
