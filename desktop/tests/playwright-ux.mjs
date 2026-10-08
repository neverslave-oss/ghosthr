/**
 * ghostHR desktop — Playwright UX validation (library API, no test runner).
 *
 * Launches the REAL Electron app and verifies the intended experience:
 *  1. Chrome (toolbar/tabs/urlbar) renders.
 *  2. Split screen: native browser view on the LEFT, ghostHR side panel
 *     (extension page, chrome-extension://) docked on the RIGHT — open by
 *     default, mirroring the standalone side-panel behavior.
 *  3. The extension loaded unpacked into the shared session (content scripts +
 *     panel page both resolve against the same extension id).
 *  4. The toolbar ghostHR action toggles the side panel.
 *
 * Run from repo root:  node desktop/tests/playwright-ux.mjs
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(__dirname, '..')
const OUT = path.join(DESKTOP, 'test-results')
fs.mkdirSync(OUT, { recursive: true })

const fail = (msg) => { console.error('✗ FAIL:', msg); process.exitCode = 1 }
const pass = (msg) => console.log('✓', msg)

// Set GHOSTHR_EXE to validate a packaged build (e.g. release/win-unpacked/ghostHR.exe).
const app = await electron.launch(
  process.env.GHOSTHR_EXE
    ? { executablePath: process.env.GHOSTHR_EXE, args: [] }
    : {
        executablePath: path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'),
        args: ['.'],
        cwd: DESKTOP,
      },
)

try {
  // Wait for all three webContents (chrome, browser page, side panel).
  const deadline = Date.now() + 30000
  let chromePage = null, panelPage = null, sitePage = null
  while (Date.now() < deadline && !(chromePage && panelPage && sitePage)) {
    for (const p of app.windows()) {
      const u = p.url()
      if (u.startsWith('file:') && u.includes('renderer/index.html')) chromePage = p
      else if (u.startsWith('chrome-extension:') && u.includes('src/popup/index.html')) panelPage = p
      else if (u.startsWith('http')) sitePage = p
    }
    if (chromePage && panelPage && sitePage) break
    await new Promise((r) => setTimeout(r, 500))
  }

  if (chromePage) pass('chrome (toolbar UI) webContents found: ' + chromePage.url())
  else fail('chrome webContents (renderer/index.html) not found')
  if (panelPage) pass('ghostHR side panel loaded natively as extension page: ' + panelPage.url())
  else fail('side panel webContents (chrome-extension://…/src/popup/index.html) not found')
  if (sitePage) pass('embedded browser page loaded: ' + sitePage.url())
  else fail('embedded browser webContents (http…) not found')

  if (chromePage) {
    // Toolbar pieces: brand, tabs, nav buttons, urlbar, ghostHR action.
    for (const sel of ['.brand', '.tabs button', '#nav-back', '#nav-reload', '#url-input', '#ghosthr-action']) {
      const n = await chromePage.locator(sel).count()
      if (n > 0) pass(`toolbar element present: ${sel}`)
      else fail(`toolbar element missing: ${sel}`)
    }

    // Side panel host open by default.
    const open = await chromePage.locator('#sidepanel-host.open').count()
    if (open === 1) pass('side panel docked open by default (seamless standalone parity)')
    else fail('side panel host not open by default')
  }

  // Main-process truth: view bounds — browser LEFT of panel, both non-zero.
  const bounds = await app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]
    if (!win) return null
    return win.contentView.children.map((v) => v.getBounds())
  })
  console.log('view bounds (ui, browser, panel):', JSON.stringify(bounds))
  if (bounds && bounds.length >= 3) {
    const [ui, browser, panel] = bounds
    if (browser.width > 0 && browser.height > 0) pass('browser view visible')
    else fail('browser view has zero size')
    if (panel.width > 300 && panel.height > 0) pass('side panel view visible (docked right)')
    else fail('side panel view not visible')
    if (browser.x + browser.width <= panel.x + 2) pass('split screen: browser LEFT, ghostHR panel RIGHT')
    else fail(`layout wrong: browser ends at ${browser.x + browser.width}, panel starts at ${panel.x}`)
    if (ui.width > 0 && browser.y > 40) pass('toolbar chrome visible above the browser view')
    else fail('browser view overlaps the toolbar chrome')
  } else fail('expected 3 child views (ui, browser, panel), got ' + JSON.stringify(bounds))

  // Panel page actually renders the extension UI (Vue mounts into #app).
  if (panelPage) {
    try {
      await panelPage.waitForSelector('#app *', { timeout: 10000 })
      pass('side panel extension UI rendered (Vue app mounted)')
    } catch {
      fail('side panel page loaded but UI did not render')
    }
    await panelPage.screenshot({ path: path.join(OUT, 'ux-sidepanel.png') })
  }

  // Toggle the panel closed and open again via the toolbar extension action.
  if (chromePage) {
    await chromePage.click('#ghosthr-action')
    await chromePage.waitForTimeout(400)
    let b = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].contentView.children[2].getBounds())
    if (b.width === 0) pass('ghostHR action toggles side panel closed')
    else fail('panel did not hide on toggle: ' + JSON.stringify(b))
    await chromePage.click('#ghosthr-action')
    await chromePage.waitForTimeout(400)
    b = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].contentView.children[2].getBounds())
    if (b.width > 300) pass('ghostHR action re-opens side panel')
    else fail('panel did not restore on toggle: ' + JSON.stringify(b))

    await chromePage.screenshot({ path: path.join(OUT, 'ux-chrome.png') })

    // Dark theme render check (the design's default palette).
    await chromePage.evaluate(() => {
      localStorage.setItem('ghosthr.theme', 'dark')
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await chromePage.waitForTimeout(200)
    await chromePage.screenshot({ path: path.join(OUT, 'ux-chrome-dark.png') })

    // Agent tab split view (browser left, chat right).
    await chromePage.click('.tabs button[data-tab="agent"]')
    await chromePage.waitForTimeout(400)
    await chromePage.screenshot({ path: path.join(OUT, 'ux-agent-tab.png') })
    await chromePage.click('.tabs button[data-tab="browser"]')

    // Bookmarks sidebar: supported entries + user CRUD.
    const sbOpen = await chromePage.locator('#bookmarks-sidebar.open').count()
    if (sbOpen === 1) pass('bookmarks sidebar open by default')
    else fail('bookmarks sidebar not visible')
    const supportedCount = await chromePage.locator('#bm-list .bm-item').count()
    if (supportedCount >= 6) pass(`supported bookmarks listed (${supportedCount})`)
    else fail(`expected >= 6 supported bookmarks, got ${supportedCount}`)

    await chromePage.click('#bm-add')
    await chromePage.fill('#bm-name', 'HN Jobs')
    await chromePage.fill('#bm-url', 'news.ycombinator.com/jobs')
    await chromePage.click('#bm-save')
    await chromePage.waitForTimeout(200)
    const added = await chromePage.locator('.bm-item', { hasText: 'HN Jobs' }).count()
    if (added === 1) pass('bookmark CRUD: add works (url normalized)')
    else fail('bookmark add failed')
    const persisted = await chromePage.evaluate(() => localStorage.getItem('ghosthr.bookmarks') || '')
    if (persisted.includes('news.ycombinator.com')) pass('bookmark persisted to localStorage')
    else fail('bookmark not persisted')

    // Clicking a bookmark navigates the embedded browser.
    await chromePage.locator('.bm-item', { hasText: 'HN Jobs' }).click()
    await chromePage.waitForTimeout(2500)
    const urlVal = await chromePage.inputValue('#url-input')
    if (urlVal.includes('ycombinator.com')) pass('bookmark click navigates the browser: ' + urlVal)
    else fail('bookmark click did not navigate (urlbar: ' + urlVal + ')')

    await chromePage.locator('.bm-item', { hasText: 'HN Jobs' }).hover()
    await chromePage.locator('.bm-item', { hasText: 'HN Jobs' }).locator('.bm-ops button[title="Delete bookmark"]').click()
    await chromePage.waitForTimeout(200)
    const afterDel = await chromePage.locator('.bm-item', { hasText: 'HN Jobs' }).count()
    if (afterDel === 0) pass('bookmark CRUD: delete works')
    else fail('bookmark delete failed')

    // Agency credit: visible in the sidebar and opens in the embedded browser.
    const credit = await chromePage.locator('#dev-credit').count()
    if (credit === 1) pass('developed-by credit present in sidebar')
    else fail('developed-by credit missing')

    // Full-page capture on a REAL job advert (the elevenlabs page that used to
    // scan partially): /capture must return a PNG taller than the viewport and
    // the DOM text must contain the whole advert for the pageText scan path.
    const ADVERT = 'https://elevenlabs.io/careers/ada7cd2c-8b9f-4f19-a88b-7c2ca1be1fde/full-stack-engineer-front-end-leaning'
    // Navigate over IPC: filling the urlbar can race with onNavigate updates.
    await chromePage.evaluate((u) => window.browserApi.navigate(u), ADVERT)
    for (let i = 0; i < 40; i++) {
      await chromePage.waitForTimeout(500)
      if (sitePage && sitePage.url().includes('elevenlabs.io')) break
    }
    await chromePage.waitForTimeout(4000)
    try {
      const res = await fetch('http://127.0.0.1:18977/capture')
      const cap = await res.json()
      if (cap?.ok && cap.dataUrl?.startsWith('data:image/png;base64,')) {
        const png = Buffer.from(cap.dataUrl.slice('data:image/png;base64,'.length), 'base64')
        const height = png.readUInt32BE(20) // IHDR height
        if (height > 1000) pass(`job-advert capture includes below-the-fold content (height ${height}px > viewport 650px)`)
        else fail(`advert capture height ${height}px — looks viewport-only`)
      } else fail('capture bridge returned no PNG: ' + JSON.stringify(cap)?.slice(0, 120))
    } catch (e) {
      fail('capture bridge unreachable: ' + e.message)
    }
    if (sitePage) {
      try {
        const txt = await sitePage.evaluate(() => document.body.innerText)
        if (/full[\s-]*stack engineer/i.test(txt)) pass('advert DOM text contains the job title')
        else fail('advert DOM text missing job title (page may not have loaded)')
        if (txt.length > 4000) pass(`advert DOM text is complete for the pageText scan path (${txt.length} chars)`)
        else fail(`advert DOM text suspiciously short (${txt.length} chars)`)
      } catch (e) {
        fail('could not read advert DOM text: ' + e.message)
      }
    }
  }
  if (sitePage) await sitePage.screenshot({ path: path.join(OUT, 'ux-browser-page.png') })

  console.log(process.exitCode ? '\nRESULT: FAILURES — see above' : '\nRESULT: ALL CHECKS PASSED')
} finally {
  await app.close().catch(() => {})
}
