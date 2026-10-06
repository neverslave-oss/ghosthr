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
import { analyze, type ParsedCv } from './ai/verdict'
import type { DetectedForm } from './content/ats'

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await openDb()
  } catch (err) {
    console.error('[ghostHR] failed to open local db on install', err)
  }
})

// Replaces the old toolbar popup: clicking the toolbar icon now opens the
// docked side panel (Leo-style sidebar next to the page).
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[ghostHR] side panel setup failed', err))

// Clear any stale badge when navigating to a fresh tab/page.
chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ text: '' }).catch(() => {})
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
    case 'GHOSTHR_JOB_DETECTED': {
      if (msg.detected) {
        await chrome.action.setBadgeText({ text: '✓' })
        await chrome.action.setBadgeBackgroundColor({ color: '#38bdf8' })
        await chrome.action.setTitle({ title: 'ghostHR — Job advert detected' })
      } else {
        await chrome.action.setBadgeText({ text: '' })
        await chrome.action.setTitle({ title: 'ghostHR' })
      }
      return { ok: true }
    }

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

    case 'GHOSTHR_SCAN_IMAGE': {
      // Vision-scan an EXTERNALLY supplied screenshot (e.g. captured by the
      // Electron desktop shell via webview.capturePage). Decouples "get the
      // image" from "scan the image": the browser extension captures its own
      // screenshot (captureActiveTab), but the desktop app cannot use
      // chrome.tabs.captureVisibleTab (unsupported in Electron), so it hands
      // the PNG in here instead. Runs the SAME vision pipeline (scanPage),
      // so settings/provider routing/persistence are identical.
      const settings = await loadSettings()
      if (!msg.imageDataUrl || typeof msg.imageDataUrl !== 'string') {
        return { ok: false, error: 'GHOSTHR_SCAN_IMAGE requires imageDataUrl' }
      }
      const scan = await scanPage({ settings, screenshotDataUrl: msg.imageDataUrl })
      if (!scan.jobDescription && !scan.fields.length) {
        return { ok: true, empty: true, scan, offline: false }
      }
      await saveJobScan({
        url: msg.url ?? '',
        title: scan.jobTitle,
        company: scan.company,
        description: scan.jobDescription,
        fields_json: JSON.stringify(scan.fields),
      })
      await saveCurrentScan(scan)
      return { ok: true, scan, settings, offline: false }
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

    case 'GHOSTHR_AGENT_CONTEXT': {
      // Full context bundle for the deep agent (desktop Agent tab). Returns
      // the current scan, latest CV, tracked applications, and provider
      // settings so the in-process LangGraph agent can gather real data via
      // its tools. Also computes the deterministic baseline verdict
      // (analyze()) which the deep agent AUGMENTS (never replaces).
      const scan = (await getCurrentScan()) as PageScan | null
      const profile = await getLatestCvProfile()
      let cv: ParsedCv | null = null
      if (profile?.parsed_json) {
        try { cv = JSON.parse(profile.parsed_json) } catch { cv = null }
      }
      const verdict = scan?.jobDescription && cv
        ? analyze({ jobText: scan.jobDescription, cv })
        : null
      const applications = await listApplications()
      const settings = await loadSettings()
      return { ok: true, scan, cv, verdict, applications, settings }
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
