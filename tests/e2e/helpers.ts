/**
 * E2E smoke harness for ghostHR — loads the BUILT extension in a real
 * Chromium (via Playwright) exactly as a user would, then asserts the
 * regressions that repeatedly bit us are actually fixed:
 *
 *   - the app shell + tabs render
 *   - tab clicks switch views (reactivity)
 *   - Settings shows all 4 AI providers with an API-key field + model picker
 *   - the welcome/setup screen shows on first run and is dismissible
 *   - no uncaught page errors / console errors
 *
 * These are the bugs that a pure unit-test run could NOT catch (Vue
 * reactivity through props, v-if+v-for precedence, init() persistence gaps)
 * but that repeatedly shipped as "build green, no errors".
 *
 * Run: `npm run build && npm run test:e2e`
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DIST_DIR = resolve(__dirname, '../../dist')

export interface PopupDiag {
  tabs: string[]
  activeTab: string | null
  mains: number
  sections: number
  scanBtn: boolean
  upload: boolean
  welcome: boolean
  providers: Array<{ label: string | null; hasKey: boolean; modelOpts: number }>
  brandGhost: boolean
}

export async function launchExtension(): Promise<{
  ctx: BrowserContext
  extId: string
}> {
  const ctx = await chromium.launchPersistentContext(
    `/tmp/ghosthr-e2e-${Date.now()}`,
    {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${DIST_DIR}`,
        `--load-extension=${DIST_DIR}`,
      ],
      viewport: { width: 460, height: 840 },
    },
  )
  let extId: string | null = null
  for (let i = 0; i < 10 && !extId; i++) {
    for (const w of ctx.serviceWorkers()) {
      const m = w.url().match(/chrome-extension:\/\/([^/]+)\//)
      if (m) {
        extId = m[1]
        break
      }
    }
    if (!extId) await new Promise((r) => setTimeout(r, 1000))
  }
  if (!extId) {
    await ctx.close()
    throw new Error('Extension did not load — no service worker found')
  }
  return { ctx, extId }
}

export function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      errors.push(`[${m.type()}] ${m.text()}`)
    }
  })
  page.on('requestfailed', (r) =>
    errors.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText ?? ''}`),
  )
  return errors
}

export async function openPanel(
  page: Page,
  extId: string,
): Promise<void> {
  await page.goto(`chrome-extension://${extId}/src/popup/index.html`, {
    waitUntil: 'load',
  })
  await page.waitForTimeout(7000)
}

export async function diagPopup(page: Page): Promise<PopupDiag> {
  return page.evaluate(() => {
    const tabBtn = (t: string) =>
      [...document.querySelectorAll('.tabbar button')].find(
        (b) => b.textContent?.trim() === t,
      )
    const tabs = [...document.querySelectorAll('.tabbar button')].map((b) =>
      (b as HTMLButtonElement).textContent!.trim(),
    )
    const activeTab =
      [...document.querySelectorAll('.tabbar button')].find((b) =>
        b.className.includes('active'),
      )?.textContent?.trim() ?? null
    const scanBtn = [...document.querySelectorAll('button')].some((b) =>
      /scan job/i.test(b.textContent || ''),
    )
    const upload = !!document.querySelector('input[type=file]')
    const welcome = !!document.querySelector('main.setup')
    // Count provider cards in the ACTIVE view only — on first run the setup
    // overlay also renders .provider blocks, so exclude main.setup.
    const providerRoot = document.body.querySelector('main:not(.setup)') ?? document.body
    const providers = [...providerRoot.querySelectorAll('.provider')].map((p) => ({
      label: p.querySelector('.provhead b')?.textContent ?? null,
      hasKey: !!p.querySelector('input[type=password]'),
      modelOpts: p.querySelector('select')?.options.length ?? 0,
    }))
    const brandMark = document.querySelector('.brand-mark svg')
    const brandGhost = !!brandMark && brandMark.querySelectorAll('path').length >= 3
    return {
      tabs,
      activeTab,
      mains: document.querySelectorAll('main').length,
      sections: document.querySelectorAll('section').length,
      scanBtn,
      upload,
      welcome,
      providers,
      brandGhost,
    }
  })
}

export async function clickTab(page: Page, label: string): Promise<void> {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll('.tabbar button')].find(
      (x) => x.textContent?.trim() === t,
    )
    if (b) (b as HTMLButtonElement).click()
  }, label)
  await page.waitForTimeout(1200)
}
