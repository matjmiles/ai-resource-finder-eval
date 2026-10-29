// Librarian workbook: the gold-set sheet as .xlsx, with an A-Z dropdown in each
// ideal_N column. Google Sheets turns Excel list validation into dropdowns on
// import, so this works with a plain Drive upload.
const ExcelJS = require('exceljs');

const EDIT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CC' } }; // pale yellow: fill these in
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E9EE' } };

const WIDTHS = {
  query: 44, jev_bucket: 11, jev_top3_helpful: 10, jev_helpful_by_rank: 12, current_results: 46,
  detected_intent: 11, unmatched_picks: 30, match_reasons: 70, times_searched: 9, last_searched_utc: 19,
};
const NUMERIC = new Set(['jev_top3_helpful', 'times_searched']);

const HOW_TO = [
  'How to fill in this sheet',
  '',
  'Each row on the Queries tab is a real search someone typed into the Resource Finder.',
  'For each query, choose the databases you would send that person to, best first:',
  '  ideal_1 = the best database, ideal_2 = the next best, and so on up to ideal_5.',
  'Click a yellow cell to open the dropdown. Type a few letters to filter the A-Z list.',
  'Use as many columns as the query needs; leave the rest blank.',
  'Choose databases whether or not the Resource Finder returned them.',
  'To skip a query you cannot judge, leave all five blank.',
  '',
  'The grey columns are for reference only, so please do not edit them:',
  '  current_results - what the Resource Finder returned, with its own relevance score',
  '  jev_bucket - why the query was picked (good, poor, near_poor, mixed), from an automated rating',
  '  match_reasons - the Resource Finder\'s "why this matches" note for each result',
  '',
  'The Databases tab lists every database in the dropdown, with vendor, subjects and types.',
  'times_recommended = 0 means the Resource Finder has never suggested it.',
  '',
  'These are real patron searches. Do not share this sheet outside the library.',
];

async function writeWorkbook(file, rows, databases, editColumns) {
  const wb = new ExcelJS.Workbook();

  const how = wb.addWorksheet('How to');
  HOW_TO.forEach((line, i) => { how.getCell(i + 1, 1).value = line; });
  how.getCell(1, 1).font = { bold: true, size: 14 };
  how.getColumn(1).width = 100;

  const queries = wb.addWorksheet('Queries', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  const columns = Object.keys(rows[0]);
  queries.columns = columns.map((key) => ({ header: key, key, width: editColumns.includes(key) ? 34 : WIDTHS[key] || 16 }));
  for (const r of rows) {
    queries.addRow(Object.fromEntries(columns.map((c) => [c, NUMERIC.has(c) && r[c] !== '' ? Number(r[c]) : r[c]])));
  }
  queries.getRow(1).font = { bold: true };
  queries.getRow(1).eachCell((cell, n) => { cell.fill = editColumns.includes(columns[n - 1]) ? EDIT_FILL : HEADER_FILL; });
  queries.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const list = `Databases!$A$2:$A$${databases.length + 1}`;
  for (let r = 2; r <= rows.length + 1; r++) {
    const row = queries.getRow(r);
    row.alignment = { vertical: 'top', wrapText: true };
    for (const key of editColumns) {
      const cell = row.getCell(columns.indexOf(key) + 1);
      cell.fill = EDIT_FILL;
      cell.dataValidation = {
        type: 'list', allowBlank: true, formulae: [list],
        showErrorMessage: true, errorStyle: 'stop',
        errorTitle: 'Not in the A-Z list', error: 'Choose a database from the dropdown (Databases tab).',
      };
    }
  }

  const dbs = wb.addWorksheet('Databases', { views: [{ state: 'frozen', ySplit: 1 }] });
  dbs.columns = [
    { header: 'database', key: 'database', width: 50 },
    { header: 'vendor', key: 'vendor', width: 24 },
    { header: 'az_status', key: 'az_status', width: 11 },
    { header: 'subjects', key: 'subjects', width: 50 },
    { header: 'types', key: 'types', width: 30 },
    { header: 'times_recommended', key: 'times_recommended', width: 12 },
  ];
  for (const d of databases) dbs.addRow({ ...d, times_recommended: Number(d.times_recommended) });
  dbs.getRow(1).font = { bold: true };
  dbs.getRow(1).eachCell((cell) => { cell.fill = HEADER_FILL; });
  dbs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

  wb.views = [{ activeTab: 1 }]; // open on Queries
  await wb.xlsx.writeFile(file);
}

module.exports = { writeWorkbook };
