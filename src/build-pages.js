// Wraps summary.html (an Artifact fragment: no doctype/head/body) into a
// standalone index.html for GitHub Pages. Run: node src/build-pages.js
const fs = require('fs');
const path = require('path');

const fragment = fs.readFileSync(path.join(__dirname, '../summary.html'), 'utf8');
const favicon =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📚</text></svg>'
  );

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resource Finder — Evaluation Summary</title>
<meta name="description" content="Evaluation of the BYU-Idaho AI Library Resource Finder: scores, failure modes, and ranked fixes from 105 synthetic queries.">
<meta property="og:title" content="AI Resource Finder — Evaluation Summary">
<meta property="og:description" content="What works, what to fix — from 105 synthetic research queries scored by AI reference-librarian judges.">
<meta property="og:type" content="website">
<link rel="icon" href="${favicon}">
</head>
<body>
${fragment}
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, '../index.html'), html);
console.log('Wrote index.html (' + html.length + ' bytes) from summary.html');
