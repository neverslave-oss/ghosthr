/**
 * ghostHR E2E smoke test — asserts the regressions that repeatedly bit us
 * are fixed, by loading the BUILT extension in a real Chromium.
 *
 * Run: `npm run build && npm run test:e2e`
 *
 * These tests deliberately launch the extension (not just the HTML page) so
 * the service-worker + chrome.* globals are present, and they drive the popup
 * like a user would. This is what catches the Vue-reactivity-through-props and
 * v-if+v-for bugs that unit tests miss.
 */
import { test, expect } from 'playwright/test'
import {
  launchExtension,
  openPanel,
  diagPopup,
  clickTab,
  collectErrors,
} from './helpers.js'

test.describe('ghostHR popup smoke', () => {
  test('renders the app shell, tabs, and brand icon with no errors', async () => {
    const { ctx, extId } = await launchExtension()
    try {
      const page = await ctx.newPage()
      const errors = collectErrors(page)
      await openPanel(page, extId)

      const d = await diagPopup(page)
      // shell + brand
      expect(d.tabs).toEqual(['Scan', 'Agent', 'Tracked', 'Settings'])
      expect(d.brandGhost).toBe(true)
      // scan view present by default
      expect(d.scanBtn).toBe(true)
      expect(d.upload).toBe(true)
      expect(d.activeTab).toBe('Scan')
      // no page errors / console errors / failed requests
      expect(errors).toEqual([])
    } finally {
      await ctx.close()
    }
  })

  test('tab clicks switch views (reactivity works)', async () => {
    const { ctx, extId } = await launchExtension()
    try {
      const page = await ctx.newPage()
      const errors = collectErrors(page)
      await openPanel(page, extId)

      await clickTab(page, 'Settings')
      let d = await diagPopup(page)
      expect(d.activeTab).toBe('Settings')

      await clickTab(page, 'Scan')
      d = await diagPopup(page)
      expect(d.activeTab).toBe('Scan')
      expect(d.scanBtn).toBe(true)

      await clickTab(page, 'Tracked')
      d = await diagPopup(page)
      expect(d.activeTab).toBe('Tracked')

      expect(errors).toEqual([])
    } finally {
      await ctx.close()
    }
  })

  test('Settings shows all AI providers with key field + populated model picker', async () => {
    const { ctx, extId } = await launchExtension()
    try {
      const page = await ctx.newPage()
      const errors = collectErrors(page)
      await openPanel(page, extId)
      await clickTab(page, 'Settings')

      const d = await diagPopup(page)
      expect(d.providers.length).toBe(4)
      for (const p of d.providers) {
        expect(p.label).toBeTruthy()
        expect(p.hasKey).toBe(true)
        expect(p.modelOpts).toBeGreaterThan(0)
      }
      expect(errors).toEqual([])
    } finally {
      await ctx.close()
    }
  })

  test('welcome/setup screen shows on first run and is dismissible', async () => {
    const { ctx, extId } = await launchExtension()
    try {
      const page = await ctx.newPage()
      const errors = collectErrors(page)
      await openPanel(page, extId)

      // first run without setupDone -> welcome shown, tabs still usable
      let d = await diagPopup(page)
      expect(d.welcome).toBe(true)
      expect(d.tabs).toEqual(['Scan', 'Agent', 'Tracked', 'Settings'])

      // dismiss via Continue -> welcome gone, Scan active
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(
          (x) => x.textContent?.trim() === 'Continue',
        )
        if (b) (b as HTMLButtonElement).click()
      })
      await page.waitForTimeout(1500)
      d = await diagPopup(page)
      expect(d.welcome).toBe(false)
      expect(d.activeTab).toBe('Scan')
      expect(errors).toEqual([])
    } finally {
      await ctx.close()
    }
  })
})
