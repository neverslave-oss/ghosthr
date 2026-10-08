/**
 * ghostHR — landing-page asset capture (Playwright, library API).
 *
 * Drives the REAL desktop app and saves marketing screenshots into assets/:
 *   desktop-browser.png        split screen: browser + ghostHR side panel (dark)
 *   desktop-browser-light.png  same, light theme
 *   desktop-agent.png          Agent tab: browser + deep-agent chat
 *   desktop-job-advert.png     a real job advert with the panel docked
 *   extension-sidepanel.png    the extension side panel UI on its own
 *
 * Run from repo root:  node desktop/tests/capture-assets.mjs
 * (Build first: `npm run build` at the root so dist/ is fresh.)
 */
import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(__dirname, '..')
const ASSETS = path.resolve(DESKTOP, '..', 'assets')
fs.mkdirSync(ASSETS, { recursive: true })

const ADVERT = 'https://elevenlabs.io/careers/ada7cd2c-8b9f-4f19-a88b-7c2ca1be1fde/full-stack-engineer-front-end-leaning'

const app = await electron.launch({
  executablePath: path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: DESKTOP,
})

/** Composite screenshot of the whole BaseWindow (chrome + native views). */
async function shootWindow(name) {
  const buf = await app.evaluate(async ({ BaseWindow, desktopCapturer }) => {
    const win = BaseWindow.getAllWindows()[0]
    if (!win) return null
    const [w, h] = win.getSize()
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: w, height: h },
    })
    const src = sources.find((s) => s.name === 'ghostHR') || sources[0]
    return src ? src.thumbnail.toPNG().toString('base64') : null
  })
  if (!buf) { console.error('✗ window capture failed for', name); return false }
  fs.writeFileSync(path.join(ASSETS, name), Buffer.from(buf, 'base64'))
  console.log('✓ saved', name)
  return true
}

try {
  // Wait for chrome + panel + browser webContents.
  const deadline = Date.now() + 30000
  let chromePage = null, panelPage = null
  while (Date.now() < deadline && !(chromePage && panelPage)) {
    for (const p of app.windows()) {
      const u = p.url()
      if (u.startsWith('file:') && u.includes('renderer/index.html')) chromePage = p
      else if (u.startsWith('chrome-extension:') && u.includes('src/popup/index.html')) panelPage = p
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  if (!chromePage || !panelPage) throw new Error('app webContents not found')

  // Ensure window is frontmost and sized for crisp shots.
  await app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]
    win.setSize(1440, 900)
    win.show()
    win.focus()
  })
  await chromePage.waitForTimeout(1200)

  // 1. Dark split screen on the homepage.
  await chromePage.evaluate(() => {
    localStorage.setItem('ghosthr.theme', 'dark')
    document.documentElement.setAttribute('data-theme', 'dark')
  })
  await chromePage.waitForTimeout(400)
  await shootWindow('desktop-browser.png')

  // 2. Light theme variant.
  await chromePage.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light')
  })
  await chromePage.waitForTimeout(400)
  await shootWindow('desktop-browser-light.png')
  await chromePage.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark')
  })

  // 3. Agent tab (split browser + chat).
  await chromePage.click('.tabs button[data-tab="agent"]')
  await chromePage.waitForTimeout(600)
  await shootWindow('desktop-agent.png')
  await chromePage.click('.tabs button[data-tab="browser"]')

  // 4. Real job advert with the ghostHR panel docked.
  await chromePage.fill('#url-input', ADVERT)
  await chromePage.click('#go')
  await chromePage.waitForTimeout(9000)
  await shootWindow('desktop-job-advert.png')

  // 5. The extension side panel UI alone (what standalone Chrome users see).
  await panelPage.screenshot({ path: path.join(ASSETS, 'extension-sidepanel.png') })
  console.log('✓ saved extension-sidepanel.png')

  console.log('\nAssets written to', ASSETS)
} finally {
  await app.close().catch(() => {})
}
