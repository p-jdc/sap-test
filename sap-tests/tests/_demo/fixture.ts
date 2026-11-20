// Offline stand-in for an SAP screen so the Test-App has something real to run
// without a test system. Delete tests/_demo once real flows exist.
export const ORDER_FORM = `<!doctype html>
<html><body>
<h1>Create Sales Order</h1>
<label>Sold-To Party <input id="soldTo" /></label>
<label>Material <input id="material" /></label>
<button id="save" onclick="
  const ok = document.getElementById('soldTo').value && document.getElementById('material').value;
  document.getElementById('msg').textContent = ok ? 'Sales order 4711 created' : 'Fill all fields';
">Save</button>
<p id="msg" role="status"></p>
</body></html>`;
