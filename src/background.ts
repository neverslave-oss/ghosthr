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

import { openDb, addApplication, listApplications, getLatestCvProfile, upsertCvProfile, saveJobScan } from './db'
import { loadSettings } from './ai/settings'
import { scanPage, type PageScan } from './ai/scanner'
import { parseCv, type CvParseInput } from './ai/cvocr'
import type { ParsedCv } from './ai/verdict'

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
      const dataUrl = await captureActiveTab()
      const scan: PageScan = await scanPage({ settings, screenshotDataUrl: dataUrl })
      if (!scan.jobDescription && !scan.fields.length) {
        return { ok: true, empty: true, scan }
      }
      await saveJobScan({
        url: msg.url ?? '',
        title: scan.jobTitle,
        company: scan.company,
        description: scan.jobDescription,
        fields_json: JSON.stringify(scan.fields),
      })
      return { ok: true, scan, settings }
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
      // Re-import lazily to avoid circular import issues; settings is a thin shim.
      const { saveSettings } = await import('./ai/settings')
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
