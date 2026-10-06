/**
 * ghostHR MV3 service worker (background).
 *
 * Orchestrates the popup <-> content-script <-> AI pipeline:
 *  - Takes a full-page screenshot of the active tab (vision scan input).
 *  - Runs the page scan + CV OCR through the configured AI providers.
 *  - Persists scans, tracked applications, and CV profiles to the local SQLite.
 *  - Relays autofill to the content script.
 * Settings are read from chrome.storage.local (see src/ai/settings.ts).
 */

import { openDb, addApplication, listApplications, getLatestCvProfile, upsertCvProfile, saveJobScan, saveCurrentScan, getCurrentScan } from './db'
import { loadSettings, saveSettings } from './ai/settings'
import { scanPage, localDetectedToScan, type PageScan } from './ai/scanner'
import { parseCv, type CvParseInput } from './ai/cvocr'
import type { ParsedCv } from './ai/verdict'
import type { DetectedForm } from './content/ats'

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await openDb()
  } catch (err) {
    console.error('[ghostHR] failed to open local db on install', err)
  }
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => {
      console.error('[ghostHR] message error', err)
      sendResponse({ ok: false, error: String(err?.message ?? err) })
    })
  return true // async
})

async function handleMessage(msg: any): Promise<any> {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { ok: false, error: 'bad message' }
  }
  await openDb()

  switch (msg.type) {
    case 'GHOSTHR_SCAN_PAGE': {
      const settings = await loadSettings()

      // Tier 1: free offline DOM detection (no LLM). Ask the content script.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      let scan: PageScan | null = null
      let offline = false
      if (tab?.id) {
        try {
          const det = await chrome.tabs.sendMessage(tab.id, { type: 'GHOSTHR_DETECT' })
          const form: DetectedForm | null = det?.form
          if (form) {
            const localScan = localDetectedToScan(form as any)
            if (localScan.fields.length || localScan.jobDescription) {
              scan = localScan
              offline = true
            }
          }
        } catch {
          // content script not injected / page not scriptable -> skip to LLM
        }
      }

      // Tier 2: vision LLM fallback (only if offline pass found nothing).
      if (!scan) {
        const dataUrl = await captureActiveTab()
        scan = await scanPage({ settings, screenshotDataUrl: dataUrl })
      }

      if (!scan.jobDescription && !scan.fields.length) {
        return { ok: true, empty: true, scan, offline }
      }
      await saveJobScan({
        url: msg.url ?? '',
        title: scan.jobTitle,
        company: scan.company,
        description: scan.jobDescription,
        fields_json: JSON.stringify(scan.fields),
      })
      await saveCurrentScan(scan)
      return { ok: true, scan, settings, offline }
    }

    case 'GHOSTHR_GET_CURRENT_SCAN': {
      return { ok: true, scan: (await getCurrentScan()) ?? null }
    }

    case 'GHOSTHR_PARSE_CV': {
      const settings = await loadSettings()
      const input: CvParseInput = { settings }
      if (msg.imageDataUrl) input.imageDataUrl = msg.imageDataUrl
      if (msg.text) input.text = msg.text
      const cv: ParsedCv = await parseCv(input)
      const id = await upsertCvProfile(
        msg.name ?? 'cv',
        cv.raw_text ?? msg.text ?? '',
        JSON.stringify(cv),
      )
      return { ok: true, id, cv }
    }

    case 'GHOSTHR_ADD_APPLICATION': {
      const id = await addApplication(msg.application)
      return { ok: true, id }
    }

    case 'GHOSTHR_LIST_APPLICATIONS': {
      return { ok: true, applications: await listApplications() }
    }

    case 'GHOSTHR_GET_CV': {
      return { ok: true, cv: await getLatestCvProfile() }
    }

    case 'GHOSTHR_GET_SETTINGS': {
      const settings = await loadSettings()
      return { ok: true, settings }
    }

    case 'GHOSTHR_SAVE_SETTINGS': {
      await saveSettings(msg.settings)
      return { ok: true }
    }

    case 'GHOSTHR_GET_CURRENT_URL': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      return { ok: true, url: tab?.url ?? '' }
    }

    case 'GHOSTHR_AUTOFILL': {
      // Route to the content script on the active tab for DOM autofill.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error('No active tab')
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'GHOSTHR_AUTOFILL',
        fields: msg.fields ?? [],
        cv: msg.cv ?? { skills: [] },
      })
      return { ok: true, filled: res?.filled ?? 0 }
    }

    default:
      return { ok: false, error: `unknown message ${msg.type}` }
  }
}

/** Capture the visible (or full-page) active tab as a PNG data URL. */
async function captureActiveTab(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
    format: 'png',
  })
  return dataUrl
}
