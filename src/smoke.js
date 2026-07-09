const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, '../data/raw');

(async () => {
  const question = 'peer reviewed research on adolescent social media use and anxiety';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const netlog = [];
  page.on('response', (r) => {
    const u = r.url();
    if (!u.match(/\.(css|js|png|jpg|svg|woff2?|ico)(\?|$)/)) netlog.push(r.status() + ' ' + u);
  });

  await page.goto('https://library-resource-finder.byui.edu/', { waitUntil: 'networkidle' });

  const input = page.getByPlaceholder('Describe what you are researching...');
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(question);

  const htmlBefore = await page.content();
  fs.writeFileSync(path.join(RAW, '_smoke_before.html'), htmlBefore);

  await input.press('Enter');

  // The submit button shows "SEARCHING..." and an indeterminate progress bar while working.
  // Wait for the progress bar to appear (search started) then disappear (search finished).
  const bar = page.locator('.mud-progress-linear-indeterminate');
  try {
    await bar.first().waitFor({ state: 'visible', timeout: 15000 });
    console.log('search started (progress bar visible)');
  } catch { console.log('WARNING: never saw progress bar'); }

  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const searching = await page.getByText('SEARCHING', { exact: false }).count();
    const barCount = await bar.count();
    const len = (await page.content()).length;
    console.log(`t=${(i + 1) * 2}s searchingBtn=${searching} bars=${barCount} len=${len}`);
    if (searching === 0 && barCount === 0 && i > 0) { console.log('SEARCH FINISHED'); break; }
  }

  const html = await page.content();
  fs.writeFileSync(path.join(RAW, '_smoke_after.html'), html);
  await page.screenshot({ path: path.join(RAW, '_smoke.png'), fullPage: true });
  fs.writeFileSync(path.join(RAW, '_smoke_net.log'), netlog.join('\n'));
  console.log('Saved after-html', html.length, 'chars;', netlog.length, 'non-asset responses');
  await browser.close();
})();
