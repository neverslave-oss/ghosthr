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
// Max CSS px height for a full-page capture (GPU texture limit + model legibility).
const MAX_CAPTURE_HEIGHT = 10000

// Some sites (e.g. elevenlabs careers) scroll inside a nested container, so
// the document content size equals the viewport and captureBeyondViewport
// still returns one screen. Expand every vertical scroller (multi-pass:
// expanding one reveals overflow on its fixed-height ancestors) and restore.
const EXPAND_SCROLLERS = `(() => {
  const mods = []
  const expand = (el) => {
    if (!el || mods.some((m) => m[0] === el)) return false
    mods.push([el, el.getAttribute('style')])
    el.style.setProperty('height', 'auto', 'important')
    el.style.setProperty('max-height', 'none', 'important')
    el.style.setProperty('overflow', 'visible', 'important')
    return true
  }
  for (let pass = 0; pass < 6; pass++) {
    let changed = false
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 8) {
        const oy = getComputedStyle(el).overflowY
        if (oy === 'auto' || oy === 'scroll' || oy === 'hidden' || oy === 'clip') changed = expand(el) || changed
      }
    }
    if (document.documentElement.scrollHeight > document.documentElement.clientHeight + 8) {
      changed = expand(document.documentElement) || changed
      changed = expand(document.body) || changed
    }
    if (!changed) break
  }
  window.__ghosthrRestoreScroll = () => {
    for (const [el, css] of mods) { if (css === null) el.removeAttribute('style'); else el.setAttribute('style', css) }
    delete window.__ghosthrRestoreScroll
  }
  // Fixed-height shells (100dvh) never grow document.scrollHeight — report the
  // real painted bottom across the expanded containers instead.
  let maxBottom = document.documentElement.scrollHeight
  for (const [el] of mods) {
    try {
      const r = el.getBoundingClientRect()
      maxBottom = Math.max(maxBottom, r.top + (window.scrollY || 0) + el.scrollHeight)
    } catch (e) {}
  }
  return Math.ceil(maxBottom)
})()`
const RESTORE_SCROLLERS = `window.__ghosthrRestoreScroll && window.__ghosthrRestoreScroll()`

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
    // Single-window browser: target=_blank / window.open navigates in place
    // instead of spawning a detached BrowserWindow.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.navigate(url)
      return { action: 'deny' }
    })
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
    // Links from the extension panel (e.g. target=_blank) open in the
    // embedded browser view, like Chrome opening a tab from its side panel.
    this.panel.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.navigate(url)
      return { action: 'deny' }
    })
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

  /**
   * DevTools-style full-size screenshot via CDP (Page.captureScreenshot with
   * captureBeyondViewport) — includes everything below the fold.
   */
  async captureFullPage() {
    const wc = this.view?.webContents
    if (!wc) throw new Error('no browser view')
    const dbg = wc.debugger
    let attached = false
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true }
    try {
      let expandedH = 0
      try {
        const ev = await dbg.sendCommand('Runtime.evaluate', { expression: EXPAND_SCROLLERS, returnByValue: true })
        expandedH = Number(ev?.result?.value) || 0
      } catch { /* best-effort */ }
      const metrics = await dbg.sendCommand('Page.getLayoutMetrics')
      const size = metrics?.cssContentSize ?? metrics?.contentSize
      const docH = size ? Math.ceil(size.height) : 0
      const fullH = Math.max(docH, expandedH)
      const clip = size
        ? {
            x: 0,
            y: 0,
            width: Math.ceil(size.width),
            height: Math.min(fullH, MAX_CAPTURE_HEIGHT),
            scale: 1,
          }
        : undefined
      const shot = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        ...(clip ? { clip } : {}),
      })
      if (!shot || !shot.data) throw new Error('empty full-page screenshot')
      return 'data:image/png;base64,' + shot.data
    } finally {
      try { await dbg.sendCommand('Runtime.evaluate', { expression: RESTORE_SCROLLERS }) } catch { /* page may have navigated */ }
      if (attached) { try { dbg.detach() } catch { /* already detached */ } }
    }
  }

  async capturePage() {
    if (!this.view) return { ok: false, error: 'no browser view' }
    try {
      return { ok: true, dataUrl: await this.captureFullPage() }
    } catch {
      // CDP unavailable (e.g. DevTools attached) -> visible viewport fallback.
    }
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
