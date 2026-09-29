'use strict';
/* Grocery Tracker client-side helpers (vanilla JS, no framework). */

function money(n) {
  return '$' + (Number(n) || 0).toFixed(2);
}

// ---- Review page: editable item rows ----
function addRow() {
  const rows = document.getElementById('rows');
  if (!rows) return;
  const div = document.createElement('div');
  div.className = 'item-row';
  div.innerHTML =
    '<input name="item_name" placeholder="Item name" autocomplete="off">' +
    '<input name="item_price" inputmode="decimal" placeholder="0.00" aria-label="Price">' +
    '<button type="button" class="btn sm danger" onclick="removeRow(this)" aria-label="Remove item">✕</button>';
  rows.appendChild(div);
  const nameInput = div.querySelector('input[name="item_name"]');
  nameInput.addEventListener('input', recalcTotal);
  div.querySelector('input[name="item_price"]').addEventListener('input', recalcTotal);
  nameInput.focus();
}

function removeRow(btn) {
  const row = btn.closest('.item-row');
  if (row) row.remove();
  recalcTotal();
}

function recalcTotal() {
  let total = 0;
  document.querySelectorAll('#rows .item-row').forEach((row) => {
    const name = row.querySelector('input[name="item_name"]').value.trim();
    const price = parseFloat(row.querySelector('input[name="item_price"]').value) || 0;
    if (name && price > 0) total += price;
  });
  const el = document.getElementById('liveTotal');
  if (el) el.textContent = money(Math.round(total * 100) / 100);
}

// ---- Upload page: show a "working" note since OCR can take a while ----
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#rows input').forEach((i) => i.addEventListener('input', recalcTotal));
  recalcTotal();

  const form = document.getElementById('uploadForm');
  if (form) {
    form.addEventListener('submit', () => {
      const btn = document.getElementById('uploadBtn');
      const note = document.getElementById('uploadNote');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Reading…';
      }
      if (note) note.hidden = false;
    });
  }
});
