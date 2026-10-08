/**
 * Diagnostic probe — replicates the content script's tier-1 offline detection
 * (collectFields + firstFieldIdx + extractJobDescription) on a live job page
 * to show exactly what the scan pipeline receives. Run:
 *   node tests/e2e/scan-probe.mjs <job-url>
 */
import { chromium } from 'playwright'

const URL_ARG = process.argv[2] || 'https://elevenlabs.io/careers/ada7cd2c-8b9f-4f19-a88b-7c2ca1be1fde/full-stack-engineer-front-end-leaning'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(URL_ARG, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
await page.waitForTimeout(3000)

const probe = await page.evaluate(() => {
  // --- collectFields (same selectors as src/content/index.ts) ---
  const selectors = [
    'textarea', 'input[type="text"]', 'input[type="email"]', 'input[type="tel"]',
    'input[type="file"]', 'input:not([type])', 'select', 'input[type="checkbox"]',
  ]
  const fields = []
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => {
      const kind = sel.startsWith('textarea') ? 'textarea'
        : sel.startsWith('select') ? 'select'
          : el.type === 'checkbox' ? 'checkbox'
            : el.type === 'file' ? 'file' : 'input'
      fields.push({
        kind,
        name: el.getAttribute('name') || el.getAttribute('id') || null,
        label: el.closest('label')?.textContent?.trim() ?? null,
        placeholder: el.getAttribute('placeholder') || null,
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      })
    })
  }
  const bodyText = document.body?.innerText ?? ''
  // --- firstFieldIdx (same as src/content/index.ts) ---
  const idx = fields
    .map((f) => {
      const needle = (f.name ?? f.placeholder ?? '').trim()
      return needle ? { needle, i: bodyText.indexOf(needle) } : { needle, i: -1 }
    })
    .filter((x) => x.i >= 0)
  const firstFieldIdx = idx.length ? Math.max(0, Math.min(...idx.map((x) => x.i))) : 0

  // --- extractJobDescription (same as src/content/ats.ts today) ---
  const slice = firstFieldIdx > 0 ? bodyText.slice(0, firstFieldIdx) : bodyText
  const paragraphs = slice.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 0)
  const sorted = paragraphs.slice().sort((a, b) => b.length - a.length)

  return {
    url: location.href,
    bodyTextLen: bodyText.length,
    fieldCount: fields.length,
    fieldSample: fields.slice(0, 10),
    needleHits: idx.slice(0, 10),
    firstFieldIdx,
    sliceLen: slice.length,
    paragraphCount: paragraphs.length,
    longestParagraphLen: sorted[0]?.length ?? 0,
    longestParagraphPreview: (sorted[0] ?? '').slice(0, 200),
    fullPreForm: paragraphs.join('\n').length,
    scrollHeight: document.documentElement.scrollHeight,
  }
})

console.log(JSON.stringify(probe, null, 2))
await browser.close()
