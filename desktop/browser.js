/**
 * ghostHR desktop — native WebContentsView browser controller (main process).
 *
 * Replaces the renderer-owned `<webview>` with a main-process `WebContentsView`
 * added to the BaseWindow's contentView. The view uses the DEFAULT session —
 * the same session `loadGhostHrExtension()` loads the ghostHR extension into —
 * so the extension's content scripts run natively on the pages shown here,
 * exactly like a real browser tab (Electron's recommended replacement for the
 * legacy <webview>, which doesn't reliably run extension content scripts).
 *
 * Browser chrome (header, urlbar, tabs, theme toggle, chat) lives in the DOM
 * renderer; only the page itself is drawn by this view. The renderer reports
 * pixel bounds over IPC (ResizeObserver + tab switch) and this controller sets
 * them via `setBounds`. Capture + scan + agent-context are moved to main because
 * the renderer can no longer call webview.capturePage()/executeJavaScript().
 */
const { WebContentsView, session, ipcMain } = require('electron')

const HOMEPAGE = 'https://www.google.com'

function normalizeUrl(input) {
  let u = String(input || '').trim()
  if (!u) return null
  // Neutral homepage / explicit scheme. No user-agent override (kept neutral).
  if (!/^(https?|file):\/\//i.test(u)) u = 'https://' + u
  return u
}

// Poll the extension's content script `data-ghosthr-result` attribute after
// dispatching the scan event into the page (same semantics as the old webview
// executeJavaScript scan, now driven from main into this view's webContents).
const SCAN_SCRIPT = (dataUrl) =>
  `(async () => {
  document.documentElement.removeAttribute('data-ghosthr-result');
  document.dispatchEvent(new CustomEvent('__ghosthr_scan_image', { detail: { imageDataUrl: ${JSON.stringify(
    dataUrl,
  )} } }));
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const raw = document.documentElement.getAttribute('data-ghosthr-result');
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  }
  return { ok: false, error: 'scan result timeout' };
})()`

// Pull the full extension context (scan/CV/verdict/apps/settings) for the deep
// agent via the `__ghosthr_agent_context` bridge event (same channel the old
// webview used), executed inside this view's webContents.
const CTX_SCRIPT = `(async () => {
  document.documentElement.removeAttribute('data-ghosthr-agent');
  document.dispatchEvent(new CustomEvent('__ghosthr_agent_context'));
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 250));
    const raw = document.documentElement.getAttribute('data-ghosthr-agent');
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  }
  return { ok: false, error: 'engine context unavailable' };
})()`

class BrowserController {
  /**
   * @param {{ sendToRenderer?: (channel: string, payload: unknown) => void }} opts
   */
  constructor({ sendToRenderer } = {}) {
    this.view = null
    this.panel = null // ghostHR side-panel WebContentsView (extension page)
    this.currentUrl = HOMEPAGE
    this._push = sendToRenderer || (() => {})
  }

  /** Create the WebContentsView, add it to the window's contentView, and start. */
  create(win) {
    this.view = new WebContentsView({
      webPreferences: {
        // DEFAULT session => the same session loadGhostHrExtension() loaded the
        // ghostHR extension into. No separate/in-memory partition, so content
        // scripts run on pages in this view.
        session: session.defaultSession,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.contentView.addChildView(this.view)
    // Rounded corners so the native view matches the chrome's card framing.
    try { this.view.setBorderRadius(14) } catch { /* older Electron */ }

    const wc = this.view.webContents
    wc.on('did-navigate', (_e, url) => {
      this.currentUrl = url
      this._push('browser:url-changed', { url })
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      this.currentUrl = url
      this._push('browser:url-changed', { url })
    })

    // Starting bounds fill the window; the renderer corrects these on boot,
    // resize, and tab switch via browser:set-bounds.
    const [w, h] = win.getSize()
    if (w && h) this.view.setBounds({ x: 0, y: 0, width: w, height: h })

    this.navigate(HOMEPAGE)
    return this.view
  }

  /**
   * Create the ghostHR side-panel view — the extension's side_panel page
   * (chrome-extension://<id>/src/popup/index.html) rendered natively in its
   * own WebContentsView docked next to the browser, mirroring Chrome's side
   * panel. Electron has no chrome.sidePanel implementation, so the desktop
   * shell provides the docked surface itself; the page runs in a real
   * extension-page context (full chrome.* APIs) in the shared default session.
   */
  createPanel(win, url) {
    if (this.panel) return this.panel
    this.panel = new WebContentsView({
      webPreferences: {
        session: session.defaultSession,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.contentView.addChildView(this.panel)
    try { this.panel.setBorderRadius(14) } catch { /* older Electron */ }
    // Hidden until the renderer reports real bounds for the panel region.
    this.panel.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    this.panel.webContents.loadURL(url).catch((e) => {
      console.warn('[ghostHR] side panel load failed:', e?.message ?? e)
    })
    return this.panel
  }

  /** Position the side panel. A zero-sized rect hides it (toggle closed). */
  setPanelBounds(r) {
    if (!this.panel) return
    const x = Math.max(0, Math.round(Number(r?.x) || 0))
    const y = Math.max(0, Math.round(Number(r?.y) || 0))
    const w = Math.max(0, Math.round(Number(r?.width) || 0))
    const h = Math.max(0, Math.round(Number(r?.height) || 0))
    this.panel.setBounds({ x, y, width: w, height: h })
  }

  /** Position/size the browser view within the window's content area. */
  setBounds(r) {
    if (!this.view) return
    const x = Math.max(0, Math.round(Number(r?.x) || 0))
    const y = Math.max(0, Math.round(Number(r?.y) || 0))
    const w = Math.max(0, Math.round(Number(r?.width) || 0))
    const h = Math.max(0, Math.round(Number(r?.height) || 0))
    if (!w || !h) {
      // Never let it collapse to zero-size (invisible) -> keep a 1px region.
      this.view.setBounds({ x, y, width: 1, height: 1 })
      return
    }
    this.view.setBounds({ x, y, width: w, height: h })
  }

  goBack() {
    const wc = this.view?.webContents
    if (!wc) return { ok: false }
    const nav = wc.navigationHistory
    if (nav?.canGoBack()) { nav.goBack(); return { ok: true } }
    return { ok: false }
  }

  goForward() {
    const wc = this.view?.webContents
    if (!wc) return { ok: false }
    const nav = wc.navigationHistory
    if (nav?.canGoForward()) { nav.goForward(); return { ok: true } }
    return { ok: false }
  }

  reload() {
    const wc = this.view?.webContents
    if (!wc) return { ok: false }
    wc.reload()
    return { ok: true }
  }

  async navigate(input) {
    if (!this.view) return { ok: false, error: 'no browser view' }
    const url = normalizeUrl(input)
    if (!url) return { ok: false, error: 'invalid URL' }
    try {
      await this.view.webContents.loadURL(url)
      return { ok: true, url }
    } catch (e) {
      return { ok: false, error: String(e && e.message) || String(e), url }
    }
  }

  async capturePage() {
    if (!this.view) return { ok: false, error: 'no browser view' }
    try {
      const image = await this.view.webContents.capturePage()
      if (!image || image.isEmpty()) {
        return { ok: false, error: 'empty capture (page not visible)' }
      }
      return { ok: true, dataUrl: image.toDataURL() }
    } catch (e) {
      return { ok: false, error: String(e && e.message) || String(e) }
    }
  }

  async scanImage(dataUrl) {
    if (!this.view) return { ok: false, error: 'no browser view' }
    try {
      const res = await this.view.webContents.executeJavaScript(SCAN_SCRIPT(dataUrl))
      return res || { ok: false, error: 'no scan result' }
    } catch (e) {
      return { ok: false, error: String(e && e.message) || String(e) }
    }
  }

  async getAgentContext() {
    if (!this.view) return { ok: false, error: 'no browser view' }
    try {
      const res = await this.view.webContents.executeJavaScript(CTX_SCRIPT)
      return res || { ok: false, error: 'no context' }
    } catch (e) {
      return { ok: false, error: String(e && e.message) || String(e) }
    }
  }

  /** Wire the renderer-driving IPC handlers once (guarded so it's idempotent). */
  registerIpc() {
    ipcMain.handle('browser:navigate', (_e, url) => this.navigate(url))
    ipcMain.handle('browser:set-bounds', (_e, rect) => {
      this.setBounds(rect)
      return { ok: true }
    })
    ipcMain.handle('browser:capture-page', () => this.capturePage())
    ipcMain.handle('browser:scan-image', (_e, dataUrl) => this.scanImage(dataUrl))
    ipcMain.handle('browser:get-agent-context', () => this.getAgentContext())
    ipcMain.handle('browser:back', () => this.goBack())
    ipcMain.handle('browser:forward', () => this.goForward())
    ipcMain.handle('browser:reload', () => this.reload())
    ipcMain.handle('panel:set-bounds', (_e, rect) => {
      this.setPanelBounds(rect)
      return { ok: true }
    })
  }

  destroy() {
    if (this.view) {
      try { this.view.webContents.close() } catch { /* already closed */ }
      this.view = null
    }
    if (this.panel) {
      try { this.panel.webContents.close() } catch { /* already closed */ }
      this.panel = null
    }
  }
}

module.exports = { BrowserController, HOMEPAGE, normalizeUrl }
