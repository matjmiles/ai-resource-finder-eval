// Minimal RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines.

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Excel's UTF-8 BOM
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// -> array of objects keyed by the header row
function readCsvObjects(text) {
  const [header, ...rows] = parseCsv(text);
  return rows
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// objects -> CSV text with a BOM so Excel opens it as UTF-8
function writeCsvObjects(objects, columns = Object.keys(objects[0] || {})) {
  const lines = [columns.map(csvField).join(',')];
  for (const o of objects) lines.push(columns.map((c) => csvField(o[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { parseCsv, readCsvObjects, writeCsvObjects, csvField };
