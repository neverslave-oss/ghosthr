/**
 * ghostHR desktop — extension bridge.
 *
 * The desktop loads the SAME built ghostHR extension into the same Electron
 * session as its <webview>. Everything the extension stores lives in
 * chrome.storage.local under the ghosthr.settings / ghosthr.db keys, so the
 * desktop's native UI (Settings panel, CV upload, scan) and the standalone
 * browser extension share ONE source of truth.
 *
 * The renderer cannot call chrome.runtime directly, so every call is relayed
 * through the webview's content script: we dispatch a CustomEvent inside the
 * webview page, the content script forwards it to the extension background and
 * writes the reply onto <html data-ghosthr-bridge>, which we poll back out.
 *
 * The scan/agent bridges use the same pattern (data-ghosthr-result /
 * data-ghosthr-agent) and are kept for back-compat; this module is the generic
 * entry used by the Settings panel and CV upload.
 *
 * Example:
 *   const { settings } = await bridgeCall('GHOSTHR_GET_SETTINGS')
 *   await bridgeCall('GHOSTHR_SAVE_SETTINGS', { settings: edited })
 */

const BRIDGE_ATTR = 'data-ghosthr-bridge'
const BRIDGE_EVENT = '__ghosthr_bridge'

/**
 * Run one extension background handler and return its response. `type` is an
 * extension message type (e.g. 'GHOSTHR_GET_SETTINGS'); `payload` is spread
 * into the message, matching how the popup store sends settings, CV, etc.
 */
export async function bridgeCall(type, payload = {}) {
  const webview = document.querySelector('webview')
  if (!webview || typeof webview.executeJavaScript !== 'function') {
    throw new Error('No browser webview available')
  }
  // Clear any prior reply, then dispatch the bridge event into the page.
  const clear = () => webview.executeJavaScript(
    `document.documentElement.removeAttribute(${JSON.stringify(BRIDGE_ATTR)}); true`,
  )
  const dispatch = () => webview.executeJavaScript(
    `document.dispatchEvent(new CustomEvent(${JSON.stringify(BRIDGE_EVENT)}, { detail: ${JSON.stringify({ type, ...payload })} })); true`,
  )
  const poll = async () => {
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 200))
      const raw = await webview.executeJavaScript(
        `document.documentElement.getAttribute(${JSON.stringify(BRIDGE_ATTR)})`,
      )
      if (raw) {
        try { return JSON.parse(raw) } catch { /* keep polling */ }
      }
    }
    return null
  }

  await clear()
  await dispatch()
  const res = await poll()
  if (!res) throw new Error('ghostHR extension did not respond')
  if (!res.ok) throw new Error(res.error || 'extension bridge error')
  return res.res ?? {}
}

/** Fetch the extension's current settings (shared with the browser addon). */
export async function getSettings() {
  const { settings } = await bridgeCall('GHOSTHR_GET_SETTINGS')
  return settings
}

/** Persist settings through the extension (writes the shared chrome.storage). */
export async function saveSettings(settings) {
  await bridgeCall('GHOSTHR_SAVE_SETTINGS', { settings })
}

/** Fetch the stored CV profile (for the desktop CV section). */
export async function getCv() {
  const { cv } = await bridgeCall('GHOSTHR_GET_CV')
  return cv
}

/** Parse a CV file (file name + optional text/data-URL) like the popup does. */
export async function parseCv(cvInput) {
  return bridgeCall('GHOSTHR_PARSE_CV', cvInput)
}

/** Full context bundle the agent reads (scan + CV + applications + settings). */
export async function getAgentContext() {
  return bridgeCall('GHOSTHR_AGENT_CONTEXT')
}
