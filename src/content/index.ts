/**
 * ghostHR content script.
 *
 * Runs on the active tab: detects an ATS application form (Workable +
 * generic), extracts the job description, and offers the verdict + application
 * tracking through the popup. Kept thin; logic lives in pure modules
 * (src/content/ats.ts, src/ai/verdict.ts) that are unit-tested.
 */

import {
  buildDetectedForm,
  looksLikeApplicationForm,
  type AthFormField,
  type DetectedForm,
} from './ats'
import { fillField, cvValueBag } from './autofill'
import type { ParsedCv } from '../ai/verdict'

function collectFields(): AthFormField[] {
  const fields: AthFormField[] = []
  const selectors = [
    'textarea',
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input:not([type])',
    'select',
    'input[type="checkbox"]',
  ]
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => {
      const html = el as HTMLElement
      const kind = sel.startsWith('textarea')
        ? 'textarea'
        : sel.startsWith('select')
          ? 'select'
          : el instanceof HTMLInputElement && el.type === 'checkbox'
            ? 'checkbox'
            : 'input'
      const label = html.closest('label')?.textContent?.trim() ?? null
      const name = html.getAttribute('name') || html.getAttribute('id') || null
      const placeholder = html.getAttribute('placeholder') || null
      const required = html.hasAttribute('required') || html.getAttribute('aria-required') === 'true'
      fields.push({ kind, name, label, placeholder, required })
    })
  }
  return fields
}

function detectAndReport(): DetectedForm | null {
  const fields = collectFields()
  const bodyText = document.body?.innerText ?? ''

  // Crude index of the first form field in the body text for description slicing.
  const firstFieldIdx = (() => {
    const idx = fields
      .map((f) => {
        const needle = (f.name ?? f.placeholder ?? '').trim()
        return needle ? bodyText.indexOf(needle) : -1
      })
      .filter((i) => i >= 0)
    return idx.length ? Math.max(0, Math.min(...idx)) : 0
  })()

  const form = buildDetectedForm({ url: location.href, bodyText, fields, firstFieldIndex: firstFieldIdx })

  if (!looksLikeApplicationForm(form.fields, bodyText)) {
    return null
  }
  return form
}

// Run once (document_idle) and stash result for the popup.
chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GHOSTHR_DETECT') {
    const form = detectAndReport()
    sendResponse({ form })
    return
  }
  if (msg?.type === 'GHOSTHR_AUTOFILL') {
    // msg.fields = ScannedField[]; msg.cv = ParsedCv
    const bag = cvValueBag((msg.cv ?? { skills: [] }) as ParsedCv)
    let filled = 0
    for (const field of msg.fields ?? []) {
      if (fillField(field, bag)) filled++
    }
    sendResponse({ ok: true, filled })
    return
  }
  return true
})
