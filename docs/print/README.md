# Printed documents

Three PDFs, built from the HTML here with the installed Chrome. The screenshots
are taken from the live console so every figure shows real state.

| File | What it is |
| --- | --- |
| `Kreaton-User-Manual.pdf` | How to use the console, for someone who has never seen a fraud system. |
| `Kreaton-Build-and-Deployment.pdf` | Every part of the system, what it is made of and why, and how it got to a public URL. |
| `Kreaton-Judge-QA.pdf` | Questions a judge will ask, grouped by what they are probing, with where to point. |

To rebuild after a console change:

```bash
cd docs/print
npm init -y && npm install playwright-core@1.49.1     # once
node shots.js        # screenshots from kreaton-upi.vercel.app (set KREATON_BASE to override)
node reshoot2.js     # the assessment panel split into evidence and cost images
node render.js       # all three PDFs into out/
```

Fonts are system fonts (Segoe UI, Cascadia Mono) on purpose: Chrome will not
embed variable web fonts into a PDF, which the first edition found out.
