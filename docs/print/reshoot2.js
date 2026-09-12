const { chromium } = require('playwright-core');
const BASE = 'https://kreaton-upi.vercel.app';
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2400 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const ready = async () => {
    await page.waitForFunction(() => /[0-9,]+ of [0-9,]+ payments replayed/.test(document.body.innerText), null, { timeout: 45000 });
    await page.waitForFunction(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Skip 50'); return b && !b.disabled; }, null, { timeout: 45000 });
    await page.waitForTimeout(400);
  };
  // Screenshot the aside's sub-sections by their headings: everything up to
  // and including the evidence table, and the expected-cost section.
  const parts = async (name) => {
    const aside = page.locator('aside').first();
    await aside.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
    const box = await aside.boundingBox();
    const costTop = await page.evaluate(() => {
      const h = [...document.querySelectorAll('aside h2, aside h3, aside header')].find(e => /Expected cost/.test(e.textContent));
      const r = h.getBoundingClientRect(); return r.top + window.scrollY;
    });
    const muleTop = await page.evaluate(() => {
      const h = [...document.querySelectorAll('aside h2, aside h3, aside header')].find(e => /Mule chain/.test(e.textContent));
      const r = h.getBoundingClientRect(); return r.top + window.scrollY;
    });
    const asideTop = box.y + await page.evaluate(() => window.scrollY);
    await page.screenshot({ path: `shots/${name}-evidence.png`, clip: { x: box.x, y: box.y, width: box.width, height: costTop - asideTop - 14 } });
    await page.screenshot({ path: `shots/${name}-cost.png`, clip: { x: box.x, y: box.y + (costTop - asideTop) - 6, width: box.width, height: muleTop - costTop - 10 } });
    console.log('parts', name);
  };

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' }); await ready();
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Skip 50' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Only the ones it stopped' }).click(); await page.waitForTimeout(300);
  await page.locator('table.feed tbody tr').first().click(); await page.waitForTimeout(500);
  await parts('console-assessment');

  await page.locator('select').filter({ hasText: 'Digital arrest' }).first().selectOption('digital_arrest');
  await page.getByRole('button', { name: 'Inject' }).click(); await page.waitForTimeout(700);
  await parts('console-injected');

  await page.goto(`${BASE}/data`); await page.waitForTimeout(700);
  const back = page.getByRole('button', { name: 'Back to the shipped corpus' });
  if (await back.count()) { await back.first().click(); await page.waitForTimeout(300); }
  await page.getByRole('button', { name: /^Bank statement/ }).click(); await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Replay this file' }).click(); await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Watch it run' }).click(); await ready();
  await page.getByRole('button', { name: 'Skip 50' }).click(); await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Only the ones it stopped' }).click(); await page.waitForTimeout(300);
  await page.locator('table.feed tbody tr').first().click(); await page.waitForTimeout(500);
  await parts('console-imported-assessment');

  await page.goto(`${BASE}/data`); await page.waitForTimeout(500);
  const back2 = page.getByRole('button', { name: 'Back to the shipped corpus' });
  if (await back2.count()) await back2.first().click();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
