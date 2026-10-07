/**
 * ghostHR desktop — integration test (vitest).
 *
 * Spawns the REAL Electron app (desktop/main.js) on a live display with
 * GHOSTHR_E2E=1 and reads the main-process debug report it prints. Asserts the
 * app chrome renders — the regression the user hit where the app opened as a
 * bare browser view with the Agent tab / header gone.
 *
 * Root cause that this guards: a WebContentsView added to a BaseWindow
 * contentView does NOT size itself — it starts at 0x0 unless setBounds is
 * called. The embedded browser view set its own full-window bounds on create,
 * so it painted ON TOP and covered the chrome (which had no bounds and was
 * invisible). Fix = give the chrome (uiView) explicit full-window bounds and
 * keep it glued on resize.
 *
 * Requires a live display on :1 (Xvnc, per the computer-use skill) and the
 * built extension (repo-root `npm run build`).
 *
 * Run: DISPLAY=:1 npx vitest run desktop/tests/desktop-shell.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import path from 'node:path'

const DESKTOP = path.resolve(__dirname, '..')
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron')

// Wait for the main process to print its [ghostHR-DEBUG] report, then quit.
function launchApp() {
  return new Promise((resolve, reject) => {
    const proc = spawn(ELECTRON, ['.'], {
      cwd: DESKTOP,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1', GHOSTHR_E2E: '1', ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('timeout waiting for [ghostHR-DEBUG]\n' + out))
    }, 20000)
    proc.stdout.on('data', (d) => { out += d.toString() })
    proc.stderr.on('data', (d) => { out += d.toString() })
    proc.on('exit', () => { /* ignore exit; debug line already captured */ })
    const hunt = setInterval(() => {
      const m = out.match(/\[ghostHR-DEBUG\] (\{.*\})/)
      if (m) {
        clearTimeout(timer)
        clearInterval(hunt)
        let dbg = null
        try { dbg = JSON.parse(m[1]) } catch { /* keep null */ }
        proc.kill('SIGKILL')
        resolve(dbg)
      }
    }, 250)
  })
}

describe('ghostHR desktop shell (real Electron on a live display)', () => {
  let dbg: any

  beforeAll(async () => {
    dbg = await launchApp()
  }, 25000)

  it('reports a live debug object', () => {
    expect(dbg).toBeTruthy()
    expect(dbg).toMatchObject({ winSize: [1280, 860] })
  })

  it('renders the chrome (uiView) with full-window bounds — not 0x0', () => {
    // Before the fix uiView had no setBounds => 0x0 and invisible.
    expect(dbg.chromeBounds).toMatchObject({ x: 0, y: 0, width: 1280, height: 860 })
  })

  it('keeps the brand header present in the chrome DOM', () => {
    expect(dbg.uiBounds).toMatchObject({ brand: true })
    expect(dbg.uiBounds.w).toBeGreaterThan(100)
    expect(dbg.uiBounds.h).toBeGreaterThan(100)
  })

  it('keeps the embedded browser view below the header (not covering it)', () => {
    // Browser must start below the header (y>0) and not fill the whole window.
    expect(dbg.browserBounds.y).toBeGreaterThan(20)
    expect(dbg.browserBounds.width).toBeLessThanOrEqual(1280)
  })
})
