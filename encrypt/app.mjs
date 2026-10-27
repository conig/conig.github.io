import { createPatientHasher, parseCSV, pseudonymiseCSV } from './linkage.mjs';

const byId = id => document.getElementById(id);
const form = byId('linkage-form');
const generate = byId('generate');
const fileInput = byId('csv-file');
const columnInput = byId('id-column');
const headerInput = byId('has-header');
const status = byId('status');
let rows = null;
let downloadURL = null;
let revision = 0;
let controller = null;
const supported = Boolean(globalThis.crypto?.subtle);
const mode = () => form.elements.mode.value;

function invalidate() {
  revision++;
  controller?.abort();
  controller = null;
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL = null;
  byId('download').removeAttribute('href');
  byId('download').download = '';
  byId('output').value = '';
  byId('single-result').hidden = true;
  byId('csv-result').hidden = true;
  byId('csv-summary').textContent = '';
  byId('error').hidden = true;
  status.textContent = '';
}

function showError(message) {
  byId('error').textContent = message;
  byId('error').hidden = false;
}

function setBusy(busy) {
  form.setAttribute('aria-busy', String(busy));
  for (const control of form.elements) control.disabled = busy && control.id !== 'clear';
  columnInput.disabled = busy || !rows;
  generate.disabled = busy || !supported;
  generate.textContent = busy ? 'Working…' : mode() === 'csv' ? 'Generate CSV' : 'Generate linkage key';
}

function updateColumns() {
  columnInput.replaceChildren();
  if (!rows) {
    columnInput.add(new Option('Choose a file first', ''));
    columnInput.disabled = true;
    byId('file-summary').textContent = '';
    return;
  }
  const previous = columnInput.dataset.selected;
  rows[0].forEach((name, index) => {
    const label = headerInput.checked && name.trim() ? `${name} (column ${index + 1})` : `Column ${index + 1}`;
    columnInput.add(new Option(label, String(index)));
  });
  const suggested = headerInput.checked ? rows[0].findIndex(name => /^(internalid|patient_?id|id)$/i.test(name.trim())) : -1;
  columnInput.value = previous ?? String(Math.max(0, suggested));
  columnInput.disabled = false;
  const count = rows.length - (headerInput.checked ? 1 : 0);
  byId('file-summary').textContent = `${count.toLocaleString()} data rows · ${rows[0].length} columns. The selected column will be replaced, not added.`;
}

form.addEventListener('input', event => {
  if (event.target.id === 'patient-id' || event.target.id === 'passphrase') invalidate();
});
for (const radio of form.elements.mode) radio.addEventListener('change', () => {
  invalidate();
  byId('single-fields').hidden = mode() !== 'single';
  byId('csv-fields').hidden = mode() !== 'csv';
  setBusy(false);
});
headerInput.addEventListener('change', () => { invalidate(); updateColumns(); });
columnInput.addEventListener('change', () => {
  columnInput.dataset.selected = columnInput.value;
  invalidate();
});

fileInput.addEventListener('change', async () => {
  invalidate();
  const current = revision;
  rows = null;
  delete columnInput.dataset.selected;
  updateColumns();
  const file = fileInput.files[0];
  if (!file) return;
  setBusy(true);
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a CSV smaller than 10 MB.');
    const bytes = await file.arrayBuffer();
    if (current !== revision) return;
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('The file is not UTF-8. Export it as a UTF-8 CSV and try again.'); }
    rows = parseCSV(source);
    updateColumns();
  } catch (error) {
    if (current === revision) showError(error.message);
  } finally {
    if (current === revision) setBusy(false);
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  invalidate();
  const current = revision;
  controller = new AbortController();
  const signal = controller.signal;
  setBusy(true);
  try {
    const id = byId('patient-id').value;
    if (mode() === 'csv' && !rows) throw new Error('Choose a valid CSV first.');
    const hash = await createPatientHasher(byId('passphrase').value);
    if (current !== revision) return;
    if (mode() === 'single') {
      const key = await hash(id);
      if (current !== revision) return;
      byId('output').value = key;
      byId('single-result').hidden = false;
      status.textContent = 'Linkage key ready.';
    } else {
      const result = await pseudonymiseCSV(rows, Number(columnInput.value), headerInput.checked, hash, {
        signal,
        onProgress: (done, total) => {
          if (current === revision) status.textContent = `Processed ${done.toLocaleString()} of ${total.toLocaleString()} rows…`;
        },
      });
      if (current !== revision) return;
      downloadURL = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
      byId('download').href = downloadURL;
      byId('download').download = `${fileInput.files[0].name.replace(/\.csv$/i, '')}_anonymised.csv`;
      byId('csv-summary').textContent = `${result.count.toLocaleString()} rows processed; ${result.empty.toLocaleString()} empty cells left blank.`;
      byId('csv-result').hidden = false;
      status.textContent = 'CSV ready. Review other columns before sharing.';
    }
  } catch (error) {
    if (current === revision && error.name !== 'AbortError') {
      status.textContent = '';
      showError(error.message);
    }
  } finally {
    if (current === revision) { controller = null; setBusy(false); }
  }
});

byId('copy').addEventListener('click', async () => {
  const current = revision;
  try {
    await navigator.clipboard.writeText(byId('output').value);
    if (current === revision) status.textContent = 'Copied to clipboard.';
  } catch {
    if (current === revision) {
      byId('output').focus();
      byId('output').select();
      status.textContent = 'Clipboard access was blocked. The key is selected; copy it manually.';
    }
  }
});

function clearAll() {
  invalidate();
  rows = null;
  form.reset();
  delete columnInput.dataset.selected;
  updateColumns();
  byId('single-fields').hidden = false;
  byId('csv-fields').hidden = true;
  setBusy(false);
}
byId('clear').addEventListener('click', () => { clearAll(); byId('patient-id').focus(); });
window.addEventListener('pagehide', clearAll);
window.addEventListener('pageshow', event => { if (event.persisted) clearAll(); });
clearAll();
if (!supported) showError('Open this page over HTTPS in a browser with Web Crypto support.');
