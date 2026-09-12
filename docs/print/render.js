/**
 * Render each HTML document to A4 PDF through the installed Chrome.
 *
 * Headers and footers are drawn by Chrome so page numbers are real. Fonts
 * are system fonts on purpose: Chrome will not embed variable web fonts in a
 * PDF (the first edition of the manual found that out), and Segoe UI and
 * Cascadia Mono are on every Windows machine this will be opened on.
 */
const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');

const DOCS = [
  ['manual.html', 'Kreaton-User-Manual.pdf', 'User manual'],
  ['build.html', 'Kreaton-Build-and-Deployment.pdf', 'Build and deployment'],
  ['judges.html', 'Kreaton-Judge-QA.pdf', 'Questions a judge will ask'],
];

const only = process.argv[2];

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage();
  for (const [src, out, label] of DOCS) {
    if (only && !src.startsWith(only)) continue;
    const file = path.join(__dirname, src);
    if (!fs.existsSync(file)) { console.log('skip (missing)', src); continue; }
    await page.goto('file:///' + file.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: path.join(__dirname, 'out', out),
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-family:Segoe UI,system-ui,sans-serif;font-size:7.5pt;color:#7b818b;padding:0 17mm;display:flex;justify-content:space-between">' +
        `<span>Kreaton · ${label}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      margin: { top: '18mm', right: '17mm', bottom: '20mm', left: '17mm' },
    });
    const pdf = fs.statSync(path.join(__dirname, 'out', out));
    console.log('wrote', out, Math.round(pdf.size / 1024), 'KB');
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
