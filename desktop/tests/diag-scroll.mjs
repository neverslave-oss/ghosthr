// Diagnose why full-page capture stays viewport-sized on inner-scroll pages.
import { _electron as electron } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(__dirname, '..')
const ADVERT = 'https://elevenlabs.io/careers/ada7cd2c-8b9f-4f19-a88b-7c2ca1be1fde/full-stack-engineer-front-end-leaning'

const app = await electron.launch({
  executablePath: path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: DESKTOP,
})
try {
  let chromePage, sitePage
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && !(chromePage && sitePage)) {
    for (const p of app.windows()) {
      const u = p.url()
      if (u.startsWith('file:') && u.includes('renderer/index.html')) chromePage = p
      else if (u.startsWith('http')) sitePage = p
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  // Navigate via the IPC bridge (urlbar fill can be overwritten by onNavigate).
  await chromePage.evaluate((u) => window.browserApi.navigate(u), ADVERT)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (sitePage.url().includes('elevenlabs.io')) break
  }
  await sitePage.waitForLoadState('load').catch(() => {})
  await chromePage.waitForTimeout(4000)
  console.log('on page:', sitePage.url())

  const diag = await sitePage.evaluate(() => {
    const mods = []
    const expand = (el) => {
      if (!el || mods.some((m) => m[0] === el)) return false
      mods.push([el, el.getAttribute('style')])
      el.style.setProperty('height', 'auto', 'important')
      el.style.setProperty('max-height', 'none', 'important')
      el.style.setProperty('overflow', 'visible', 'important')
      return true
    }
    const passes = []
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
      passes.push({ pass, changed, docScrollH: document.documentElement.scrollHeight, docClientH: document.documentElement.clientHeight })
      if (!changed) break
    }
    return { passes, expanded: mods.length, finalDocScrollH: document.documentElement.scrollHeight, finalBodyScrollH: document.body.scrollHeight }
  })
  console.log(JSON.stringify(diag, null, 2))
} finally {
  await app.close().catch(() => {})
}
