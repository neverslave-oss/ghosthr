// One-off probe: reload the desktop chrome page with pageerror listeners to
// surface renderer boot errors. Run: node desktop/tests/renderer-errors.mjs
import { _electron as electron } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = await electron.launch({
  executablePath: path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: DESKTOP,
})
try {
  let chromePage = null
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !chromePage) {
    chromePage = app.windows().find((p) => p.url().includes('renderer/index.html')) ?? null
    if (!chromePage) await new Promise((r) => setTimeout(r, 400))
  }
  if (!chromePage) throw new Error('chrome page not found')
  chromePage.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
  chromePage.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()) })
  await chromePage.reload()
  await chromePage.waitForTimeout(3000)
  console.log('reload done')
} finally {
  await app.close().catch(() => {})
}
