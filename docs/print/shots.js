/**
 * Screenshots for the three documents, taken from the live console.
 *
 * Every shot is of real state: the replay is run, files are imported, a
 * payment is composed, so nothing here is an empty page with zero counters.
 * Deterministic where it can be (the shipped slice replays identically), and
 * the viewport is fixed so the images sit at a known size in the PDFs.
 */
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.KREATON_BASE ?? 'https://kreaton-upi.vercel.app';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const W = 1280;
const H = 800;

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.waitForTimeout(opts.settle ?? 400);
  if (opts.selector) {
    const el = page.locator(opts.selector).first();
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await el.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: opts.full ?? false });
  }
  console.log('  shot', name);
}

async function ready(page) {
  await page.waitForFunction(() => /[0-9,]+ of [0-9,]+ payments replayed/.test(document.body.innerText), null, { timeout: 45000, polling: 250 });
  // The ready state also needs the Skip button enabled, which follows the slice load.
  await page.waitForFunction(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Skip 50'); return b && !b.disabled; }, null, { timeout: 45000, polling: 250 });
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await ctx.newPage();

  // --- Console, shipped corpus ------------------------------------------
  console.log('console');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await ready(page);
  await shot(page, 'console-fresh');

  // Replay 400 payments so the counters and the ribbon have content.
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Skip 50' }).click();
  await page.waitForTimeout(600);
  await shot(page, 'console-running');
  await shot(page, 'console-key', { selector: '.key' });
  await shot(page, 'console-stats', { selector: '.stats' });
  await shot(page, 'console-ribbon', { selector: 'section:has(> header:has-text("placed by size"))' });

  // Filter to interventions and pick the top one so the assessment fills.
  await page.getByRole('button', { name: 'Only the ones it stopped' }).click();
  await page.waitForTimeout(400);
  await shot(page, 'console-feed-filtered', { selector: 'table.feed' });
  const firstRow = page.locator('table.feed tbody tr').first();
  await firstRow.click();
  await page.waitForTimeout(500);
  await shot(page, 'console-assessment', { selector: 'aside' });

  // Inject a scenario.
  await page.selectOption('select:near(:text("Inject"))', 'digital_arrest').catch(async () => {
    await page.locator('select').filter({ hasText: 'Digital arrest' }).first().selectOption('digital_arrest');
  });
  await page.getByRole('button', { name: 'Inject' }).click();
  await page.waitForTimeout(700);
  await shot(page, 'console-injected', { selector: 'aside' });
  await shot(page, 'console-inject-controls', { selector: 'section:has(> header:has-text("Try a scam"))' });

  // --- Your data --------------------------------------------------------
  console.log('data');
  await page.goto(`${BASE}/data`);
  await page.waitForTimeout(800);
  await shot(page, 'data-choose');

  await page.getByRole('button', { name: /^Bank statement/ }).click();
  await page.waitForTimeout(600);
  await shot(page, 'data-mapping-top');
  await shot(page, 'data-mapping-rows', { selector: '.map-group' });
  await shot(page, 'data-preview', { selector: 'section:has(> header:has-text("How the first rows read"))' });
  await shot(page, 'data-report', { selector: 'section:has(> header:has-text("cannot show"))' });

  await page.getByRole('button', { name: 'Replay this file' }).click();
  await page.waitForTimeout(900);
  await shot(page, 'data-loaded', { selector: 'section:has(> header:has-text("Loaded"))' });

  await page.getByRole('button', { name: 'Watch it run' }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Skip 50' }).click();
  await page.waitForTimeout(700);
  await shot(page, 'console-imported');
  await page.getByRole('button', { name: 'Only the ones it stopped' }).click();
  await page.waitForTimeout(300);
  await page.locator('table.feed tbody tr').first().click();
  await page.waitForTimeout(500);
  await shot(page, 'console-imported-assessment', { selector: 'aside' });

  // Restore, then the composed-payment tab.
  await page.goto(`${BASE}/data`);
  await page.waitForTimeout(600);
  const back = page.getByRole('button', { name: 'Back to the shipped corpus' });
  if (await back.count()) await back.first().click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'One payment' }).click();
  await page.waitForTimeout(400);
  await shot(page, 'compose-presets', { selector: 'section:has(> header:has-text("Start from"))' });
  await page.getByRole('button', { name: /^Digital arrest/ }).click();
  await page.waitForTimeout(300);
  await shot(page, 'compose-form', { selector: 'section:has(> header:has-text("What was happening"))' });
  await page.getByRole('button', { name: 'Authorise this payment' }).click();
  await page.waitForTimeout(600);
  await shot(page, 'compose-decision', { selector: 'section:has(> header:has-text("The decision"))' });
  await shot(page, 'compose-api', { selector: 'section:has(> header:has-text("API request"))' });

  // --- Other routes -----------------------------------------------------
  for (const [route, name] of [
    ['/policy', 'policy'],
    ['/trace', 'trace'],
    ['/audit', 'audit'],
    ['/adversarial', 'adversarial'],
    ['/portfolio', 'portfolio'],
    ['/model', 'model'],
  ]) {
    console.log(name);
    await page.goto(`${BASE}${route}`);
    await page.waitForTimeout(1200);
    await shot(page, name, { settle: 600 });
  }

  // Health endpoint as rendered JSON.
  await page.goto(`${BASE}/api/v1/health`);
  await page.waitForTimeout(400);
  await shot(page, 'api-health', { settle: 200 });

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/`);
  await ready(page);
  await page.getByRole('button', { name: 'Skip 50' }).click();
  await page.waitForTimeout(600);
  await shot(page, 'phone-console');
  await page.goto(`${BASE}/data`);
  await page.waitForTimeout(600);
  await shot(page, 'phone-data');

  await browser.close();
  console.log('done:', fs.readdirSync(OUT).length, 'files');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
