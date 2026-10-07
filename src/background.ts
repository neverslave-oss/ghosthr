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

import { openDb, addApplication, listApplications, getActiveCvProfile, listCvProfiles, setActiveCvProfile, getLatestCvProfile, upsertCvProfile, saveJobScan, saveCurrentScan, getCurrentScan, getCurrentScanUrl, getJobScanByUrl, type JobScan } from './db'
import { loadSettings, saveSettings } from './ai/settings'
import { scanPage, localDetectedToScan, isOfflineScanSparse, type PageScan, type ScannedField } from './ai/scanner'
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
      const url = msg.url ?? ''

      // Cache-first: if this URL was parsed before and the user did NOT ask to
      // force a re-scan, reuse the stored scan instead of running the AI again.
      // The auto-scan on page open uses force=false; an explicit "Scan job page"
      // action passes force=true to re-parse.
      const cachedScan = await getJobScanByUrl(url)
      if (cachedScan && msg.force !== true) {
        const cached = scanFromJobScan(cachedScan)
        // A zero-fields scan means we parsed the page BEFORE its form rendered
        // (modern single-page ATS: the form appears only after client-side
        // interaction). Serving that as canonical would keep the fields empty
        // forever on the SAME url — exactly the elevenlabs.io bug. Only reuse a
        // cached scan that actually captured fields; otherwise fall through and
        // re-parse (a later pass on the same url can now see the form).
        if (cached.fields.length > 0) {
          await saveCurrentScan(cached, url)
          return { ok: true, scan: cached, settings, cached: true, offline: false }
        }
      }

      // Tier 1: free offline DOM detection (no LLM). Ask the content script.
      const tab = await getActiveWebTab()
      let scan: PageScan | null = null
      let offline = false
      if (tab?.id) {
        try {
          const det = await chrome.tabs.sendMessage(tab.id, { type: 'GHOSTHR_DETECT' })
          const form: DetectedForm | null = det?.form
          if (form) {
            const localScan = localDetectedToScan(form as any)
            // Only trust the free offline pass when it actually recovered a
            // sensible field set — modern (React/Vue) ATS forms often yield
            // only a couple of inputs to the selector heuristic, in which
            // case the vision-LLM scan should read the rendered page for the
            // full field list (+ job title/company the offline pass can't get).
            if (
              !isOfflineScanSparse(localScan) &&
              (localScan.fields.length || localScan.jobDescription)
            ) {
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
        let dataUrl: string
        try {
          dataUrl = await captureActiveTab()
        } catch {
          // Electron (desktop) has no chrome.tabs.captureVisibleTab — tell the
          // popup so it can route the screenshot through the shell's bridge.
          return { ok: false, captureUnavailable: true, error: 'Screen capture unavailable here.' }
        }
        scan = await scanPage({ settings, screenshotDataUrl: dataUrl })
      }

      if (!scan.jobDescription && !scan.fields.length) {
        return { ok: true, empty: true, scan, offline }
      }
      // Don't persist a field-less scan (overview page, or an SPA parsed before
      // its form rendered) as the canonical cache — otherwise cache-first would
      // keep returning it and fields would stay empty on this url. Only cache
      // a scan that actually recovered fields.
      if (scan.fields.length > 0) {
        await saveJobScan({
          url,
          title: scan.jobTitle,
          company: scan.company,
          description: scan.jobDescription,
          fields_json: JSON.stringify(scan.fields),
        })
      }
      await saveCurrentScan(scan, url)
      return { ok: true, scan, settings, offline, cached: false }
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
      const url = msg.url ?? ''
      // Idempotent: reuse a prior scan for this URL unless explicitly forcing.
      const cachedScan = await getJobScanByUrl(url)
      if (cachedScan && msg.force !== true) {
        const cached = scanFromJobScan(cachedScan)
        // Only reuse a cached scan that captured fields — a zero-fields scan
        // (SPA parsed before the form rendered) must not be served as canonical,
        // or fields stay empty on this url.
        if (cached.fields.length > 0) {
          await saveCurrentScan(cached, url)
          return { ok: true, scan: cached, settings, cached: true, offline: false }
        }
      }
      const scan = await scanPage({ settings, screenshotDataUrl: msg.imageDataUrl })
      if (!scan.jobDescription && !scan.fields.length) {
        return { ok: true, empty: true, scan, offline: false }
      }
      if (scan.fields.length > 0) {
        await saveJobScan({
          url,
          title: scan.jobTitle,
          company: scan.company,
          description: scan.jobDescription,
          fields_json: JSON.stringify(scan.fields),
        })
      }
      await saveCurrentScan(scan, url)
      return { ok: true, scan, settings, offline: false, cached: false }
    }

    case 'GHOSTHR_GET_CURRENT_SCAN': {
      return { ok: true, scan: (await getCurrentScan()) ?? null, url: await getCurrentScanUrl() }
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
      // the current scan, active CV, tracked applications, and provider
      // settings so the in-process LangGraph agent can gather real data via
      // its tools. Also computes the deterministic baseline verdict
      // (analyze()) which the deep agent AUGMENTS (never replaces).
      const scan = (await getCurrentScan()) as PageScan | null
      const profile = await getActiveCvProfile()
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
      const appIn = msg.application ?? {}
      // Dedupe: the same job URL (or company+role when no URL) is one application.
      const existing = (await listApplications()).find((a) =>
        appIn.job_url && a.job_url
          ? a.job_url === appIn.job_url
          : a.company === appIn.company && a.role === appIn.role,
      )
      if (existing) return { ok: true, id: existing.id, duplicate: true }
      const id = await addApplication(appIn)
      return { ok: true, id }
    }

    case 'GHOSTHR_LIST_APPLICATIONS': {
      return { ok: true, applications: await listApplications() }
    }

    case 'GHOSTHR_GET_CV': {
      // Returns the ACTIVE (selected) profile, not just the latest.
      return { ok: true, cv: await getActiveCvProfile() }
    }

    case 'GHOSTHR_LIST_CV': {
      return { ok: true, profiles: await listCvProfiles() }
    }

    case 'GHOSTHR_SET_ACTIVE_CV': {
      if (typeof msg.id !== 'number') {
        return { ok: false, error: 'GHOSTHR_SET_ACTIVE_CV requires a numeric id' }
      }
      await setActiveCvProfile(msg.id)
      return { ok: true }
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
      const tab = await getActiveWebTab()
      return { ok: true, url: tab?.url ?? '' }
    }

    case 'GHOSTHR_AUTOFILL': {
      // Route to the content script on the active tab for DOM autofill.
      const tab = await getActiveWebTab()
      if (!tab?.id) throw new Error('No active tab')
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'GHOSTHR_AUTOFILL',
        fields: msg.fields ?? [],
        cv: msg.cv ?? { skills: [] },
        generated: msg.generated ?? [],
      })
      return { ok: true, filled: res?.filled ?? 0 }
    }

    default:
      return { ok: false, error: `unknown message ${msg.type}` }
  }
}

/**
 * Resolve the tab scans/autofill should target. Layered because Electron's
 * chrome.tabs.query is only partial (currentWindow unsupported) and in the
 * desktop every webContents (shell chrome, side panel) registers as a tab —
 * always prefer an http(s) page over extension/file surfaces.
 */
async function getActiveWebTab(): Promise<chrome.tabs.Tab | null> {
  const isWeb = (t: chrome.tabs.Tab) => !!t.url && /^https?:/i.test(t.url)
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const web = tabs.find(isWeb)
    if (web) return web
  } catch { /* partial tabs API (desktop) */ }
  try {
    const tabs = await chrome.tabs.query({ active: true })
    const web = tabs.find(isWeb)
    if (web) return web
  } catch { /* ignore */ }
  try {
    const all = await chrome.tabs.query({})
    return all.find(isWeb) ?? null
  } catch { /* ignore */ }
  return null
}

/** Capture the visible (or full-page) active tab as a PNG data URL. */
async function captureActiveTab(): Promise<string> {
  const tab = await getActiveWebTab()
  if (!tab?.id) throw new Error('No active tab')
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
    format: 'png',
  })
  return dataUrl
}

/** Replay a stored JobScan row back into the PageScan shape the popup expects. */
function scanFromJobScan(scan: JobScan): PageScan {
  let fields: ScannedField[] = []
  try {
    const raw = JSON.parse(scan.fields_json)
    if (Array.isArray(raw)) fields = raw as ScannedField[]
  } catch {
    fields = []
  }
  return {
    jobTitle: scan.title,
    company: scan.company,
    jobDescription: scan.description,
    fields,
    applyUrl: undefined,
  }
}
