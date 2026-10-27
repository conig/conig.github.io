// Match the supplied SQL: SHA256(nvarchar bytes) is the HMAC key,
// not the passphrase itself. SQL nvarchar uses UTF-16 little-endian, no BOM.
export function utf16le(value) {
  const bytes = new Uint8Array(value.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
  return bytes;
}

export function validatePhrase(phrase) {
  // Count UTF-16 code units conservatively (SQL LEN depends on collation).
  if (phrase.length < 12 || phrase.length > 200 || phrase.startsWith(' ') || phrase.endsWith(' ') ||
      phrase.toUpperCase() === 'REPLACE_WITH_YOUR_PRIVATE_PHRASE') {
    throw new Error('Use a private passphrase of 12–200 characters, with no spaces at either end.');
  }
}

export async function createPatientHasher(phrase) {
  validatePhrase(phrase);
  if (!globalThis.crypto?.subtle) throw new Error('Open this page over HTTPS in a browser with Web Crypto support.');
  const bytes = utf16le(phrase);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  bytes.fill(0);
  const key = await crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  new Uint8Array(digest).fill(0);
  return async (id) => {
    const canonical = normalisePatientID(id);
    if (canonical === null) return '';
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`patient|${canonical}`));
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  };
}

// Strings and BigInt avoid rounding SQL bigint IDs above Number.MAX_SAFE_INTEGER.
export function normalisePatientID(value) {
  const text = value.trim();
  if (text === '') return null;
  if (!/^[+-]?\d+$/.test(text)) throw new Error('IDs must be whole numbers, not decimals, scientific notation or linkage keys.');
  const id = BigInt(text);
  if (id < -9223372036854775808n || id > 9223372036854775807n) {
    throw new Error('ID is outside the SQL bigint range.');
  }
  return id > 0n ? id.toString() : null;
}

// Strict comma-separated CSV, including quoted commas, quotes and newlines.
// Ignore empty physical lines, but preserve explicit empty records ("" or ,).
export function parseCSV(source) {
  const text = source.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false, started = false;
  function finishField() {
    row.push(field);
    field = '';
    closed = false;
  }
  function finishRow() {
    if (started || row.length || field !== '') {
      finishField();
      rows.push(row);
    }
    row = [];
    started = false;
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += ch;
    } else if (ch === ',') {
      started = true;
      finishField();
    } else if (ch === '\r' || ch === '\n') {
      finishRow();
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else if (ch === '"' && field === '' && !closed) {
      quoted = true;
      started = true;
    } else {
      if (closed || ch === '"') throw new Error('Malformed CSV: check the quoting around fields.');
      field += ch;
      started = true;
    }
  }
  if (quoted) throw new Error('Malformed CSV: a quoted field is not closed.');
  finishRow();
  if (!rows.length) throw new Error('The CSV is empty.');
  const width = rows[0].length;
  rows.forEach((record, index) => {
    if (record.length !== width) throw new Error(`CSV record ${index + 1} has ${record.length} columns; expected ${width}. Use a comma-separated CSV.`);
  });
  return rows;
}

export function stringifyCSV(rows) {
  // Quoting every cell preserves explicit blank records in one-column vectors.
  // This preserves other columns verbatim; it does NOT sanitise spreadsheet formulas.
  return '\uFEFF' + rows.map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
}

export async function pseudonymiseCSV(rows, column, hasHeader, hash, { onProgress = () => {}, signal } = {}) {
  if (!Number.isInteger(column) || column < 0 || column >= rows[0].length) throw new Error('Choose an ID column.');
  const start = hasHeader ? 1 : 0;
  if (rows.length <= start) throw new Error('The CSV has no data rows.');
  // Validate all records before producing any output; never silently hash bad IDs.
  const ids = rows.slice(start).map((row, index) => {
    try { return normalisePatientID(row[column]); }
    catch (error) { throw new Error(`CSV record ${index + start + 1}: ${error.message}`); }
  });
  const output = hasHeader ? [[...rows[0]]] : [];
  let empty = 0;
  for (let i = 0; i < ids.length; i++) {
    signal?.throwIfAborted();
    const record = [...rows[i + start]];
    record[column] = ids[i] === null ? '' : await hash(ids[i]);
    if (ids[i] === null) empty++;
    output.push(record);
    if ((i + 1) % 250 === 0) {
      onProgress(i + 1, ids.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  signal?.throwIfAborted();
  onProgress(ids.length, ids.length);
  return { csv: stringifyCSV(output), count: ids.length, empty };
}
