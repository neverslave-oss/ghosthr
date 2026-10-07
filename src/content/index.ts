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
  looksLikeJobAdvert,
  type AthFormField,
  type DetectedForm,
} from './ats'
import { fillField, fillFieldValue, cvValueBag } from './autofill'
import type { GeneratedField } from '../ai/genfill'
import type { ParsedCv } from '../ai/verdict'

/** Derive a Workable-style apply URL from a job-overview URL (…/j/<id>/ → …/j/<id>/apply/). */
export function deriveApplyUrl(url: string): string | null {
  if (/apply\.workable\.com\//i.test(url) && /\/j\/[^/]+\/?$/i.test(url)) {
    return url.replace(/\/?$/, '/apply/')
  }
  return null
}

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

  const applyUrl = deriveApplyUrl(location.href)
  const form = buildDetectedForm({ url: location.href, bodyText, fields, firstFieldIndex: firstFieldIdx, applyUrl })

  // Application form page (has prefillable fields) OR a job-advert overview page
  // whose form lives on a separate apply URL. Both are "job adverts detected".
  if (looksLikeApplicationForm(form.fields, bodyText) || looksLikeJobAdvert(bodyText)) {
    return form
  }
  return null
}

// Run once (document_idle) and stash result for the popup.
chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GHOSTHR_DETECT') {
    const form = detectAndReport()
    sendResponse({ form })
    return
  }
  if (msg?.type === 'GHOSTHR_AUTOFILL') {
    // msg.fields = ScannedField[]; msg.cv = ParsedCv;
    // msg.generated = { label, value }[] (agent-generated answers for the
    // fields the deterministic CV mapping can't fill: textareas, questions…)
    const bag = cvValueBag((msg.cv ?? { skills: [] }) as ParsedCv)
    let filled = 0
    for (const field of msg.fields ?? []) {
      if (fillField(field, bag)) filled++
    }
    // Then apply agent-generated answers, keyed by exact label. Fill every
    // generated value even if deterministic already filled it (the generated
    // value is the richer, tailored answer for free-text/textarea fields).
    for (const g of (msg.generated ?? []) as GeneratedField[]) {
      const field = (msg.fields ?? []).find((f: any) => f.label === g.label)
      const scoped = field ?? { label: g.label, kind: 'input', required: false }
      if (fillFieldValue(scoped as any, g.value)) filled++
    }
    sendResponse({ ok: true, filled })
    return
  }
  return true
})

// Auto-detect on load and ping the background to show the toolbar badge when a
// job advert is present on the page.
;(async () => {
  try {
    const form = detectAndReport()
    if (form) {
      chrome.runtime?.sendMessage?.({ type: 'GHOSTHR_JOB_DETECTED', detected: true })
    }
  } catch {
    /* badge is best-effort */
  }
})()

// ---------------------------------------------------------------------------
// Desktop vision-scan bridge.
//
// The Electron desktop shell captures the page itself (webview.capturePage —
// the chrome.tabs.captureVisibleTab API is not supported in Electron) and
// needs the captured PNG run through the SAME vision pipeline as a browser
// scan. The renderer (parent page) cannot call chrome.runtime directly, so it
// injects the image into the webview via executeJavaScript -> dispatches a
// CustomEvent with the image. CustomEvents DO cross the isolated-content-script
// boundary. The content script relays the image to the background
// GHOSTHR_SCAN_IMAGE handler and writes the result onto a DOM attribute on <html>
// (an out-of-band channel the parent can poll via executeJavaScript; the
// isolated/main worlds do not share JS globals).
// ---------------------------------------------------------------------------
document.addEventListener('__ghosthr_scan_image', (ev) => {
  const d = (ev as CustomEvent).detail as { imageDataUrl?: string } | undefined
  const dataUrl = d?.imageDataUrl
  if (typeof dataUrl !== 'string' || !dataUrl) return
  void (async () => {
    try {
      const res = await chrome.runtime?.sendMessage?.({
        type: 'GHOSTHR_SCAN_IMAGE',
        imageDataUrl: dataUrl,
      })
      document.documentElement?.setAttribute('data-ghosthr-result', JSON.stringify(res))
    } catch (err) {
      document.documentElement?.setAttribute(
        'data-ghosthr-result',
        JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }),
      )
    }
  })()
})

// Desktop Agent-tab bridge: same pattern as above but for the coaching context.
// The renderer dispatches __ghosthr_agent_context (no payload needed) and we
// write the scan + CV + verdict back onto <html data-ghosthr-agent>.
document.addEventListener('__ghosthr_agent_context', () => {
  void (async () => {
    try {
      const res = await chrome.runtime?.sendMessage?.({ type: 'GHOSTHR_AGENT_CONTEXT' })
      document.documentElement?.setAttribute('data-ghosthr-agent', JSON.stringify(res))
    } catch (err) {
      document.documentElement?.setAttribute(
        'data-ghosthr-agent',
        JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }),
      )
    }
  })()
})

// ---------------------------------------------------------------------------
// Desktop generic bridge.
//
// The desktop Settings panel (and CV upload) need to call the extension's own
// background handlers (GHOSTHR_GET_SETTINGS / GHOSTHR_SAVE_SETTINGS /
// GHOSTHR_GET_CV / GHOSTHR_PARSE_CV ...) so the DESKTOP writes the SAME
// chrome.storage.local the standalone browser extension uses. The renderer
// can't reach chrome.runtime directly, so it dispatches a CustomEvent here and
// we relay the { type, payload } to the background and write the reply to a
// <html> attribute the renderer polls — exactly like the scan/agent bridges.
document.addEventListener('__ghosthr_bridge', (ev) => {
  const d = (ev as CustomEvent).detail as { type?: string; payload?: any } | undefined
  const type = d?.type
  if (typeof type !== 'string' || !type) return
  void (async () => {
    try {
      const res = await chrome.runtime?.sendMessage?.({ type, ...(d?.payload ?? {}) })
      document.documentElement?.setAttribute(
        'data-ghosthr-bridge',
        JSON.stringify({ ok: true, res }),
      )
    } catch (err) {
      document.documentElement?.setAttribute(
        'data-ghosthr-bridge',
        JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }),
      )
    }
  })()
})
