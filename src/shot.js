const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const b = await chromium.launch();
  const fileUrl = 'file://' + path.join(__dirname, '..', 'summary.html').replace(/\\/g, '/');
  const p = await b.newPage({ viewport: { width: 1100, height: 900 } });
  await p.goto(fileUrl);
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(__dirname, '../data/raw/_dash_light.png'), fullPage: true });
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(__dirname, '../data/raw/_dash_dark.png'), fullPage: true });
  await b.close();
  console.log('screenshots saved');
})();
