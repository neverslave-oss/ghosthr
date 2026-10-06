/**
 * ghostHR MV3 service worker (background).
 *
 * Handles extension lifecycle + messaging between the content script and the
 * popup. All data lives in the local SQLite DB (src/db). No network calls in
 * standalone mode; provider routing is a Phase-1-optional layer kept behind an
 * explicit flag so the extension works fully offline by default.
 */

import { openDb, addApplication, listApplications, getLatestCvProfile, upsertCvProfile } from './db'

chrome.runtime.onInstalled.addListener(async () => {
  // Warm the local DB so first popup open is instant.
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
  return true // async response
})

async function handleMessage(msg: any): Promise<any> {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { ok: false, error: 'bad message' }
  }
  const db = await openDb()

  switch (msg.type) {
    case 'GHOSTHR_ADD_APPLICATION': {
      const id = addApplication(msg.application)
      return { ok: true, id }
    }
    case 'GHOSTHR_LIST_APPLICATIONS': {
      return { ok: true, applications: listApplications() }
    }
    case 'GHOSTHR_GET_CV': {
      return { ok: true, cv: getLatestCvProfile() }
    }
    case 'GHOSTHR_SAVE_CV': {
      const id = upsertCvProfile(msg.name ?? 'unnamed', msg.rawText ?? '', JSON.stringify(msg.parsed ?? {}))
      return { ok: true, id }
    }
    default:
      return { ok: false, error: `unknown message ${msg.type}` }
  }
}
