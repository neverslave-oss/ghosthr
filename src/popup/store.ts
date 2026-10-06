/**
 * ghostHR popup shared store.
 *
 * Holds all popup state + actions (scan, CV, verdict, applications, settings,
 * dynamic model picker). Extracted from App.vue so each popup file stays well
 * under the project's 400 LOC guideline and the view components stay thin.
 */
import { computed, reactive, ref } from 'vue'
import { analyze, type ParsedCv, type Verdict } from '../ai/verdict'
import { PROVIDER_CATALOG, PROVIDER_ORDER, type ProviderId } from '../ai/providers'
import { hasUsableProvider, type Settings, type ThemePref } from '../ai/settings'
import { getProviderModels, type ModelChoice } from '../ai/models'
import type { PageScan } from '../ai/scanner'
import { detectCvKind, blobToDataUrl, extractDocxText, type CvFileKind } from '../ai/cvocr'
import { extractPdfText, rasterizePdf } from '../ai/pdftools'

export type Tab = 'scan' | 'track' | 'settings'
type Msg = { type: string; [k: string]: any }

export const providerOrder = PROVIDER_ORDER

/** The full store shape returned by usePopupStore (for component props). */
export type PopupStore = ReturnType<typeof usePopupStore>

export function usePopupStore() {
  // UI
  const tab = ref<Tab>('scan')
  const status = ref('')
  const statusError = ref(false)
  const loading = ref(false)

  // Settings
  const settings = ref<Settings | null>(null)

  // Scan + verdict
  const scan = ref<PageScan | null>(null)
  const scannedUrl = ref('')
  const verdict = ref<Verdict | null>(null)

  // CV
  const cv = ref<ParsedCv | null>(null)
  const cvFileName = ref('')
  const cvKind = ref<CvFileKind>('pdf')

  // Tracked
  const applications = ref<any[]>([])

  // Dynamic model picker
  const modelChoices = ref<Record<ProviderId, ModelChoice[]>>({} as any)
  const modelLoading = ref(false)

  const recClass: Record<string, string> = reactive({
    apply_now: 'apply_now',
    apply_with_caveats: 'apply_with_caveats',
    hold_back: 'hold_back',
  })

  const cvShortName = computed(() => {
    if (!cvFileName.value) return 'No CV loaded'
    return cvFileName.value.length > 26 ? cvFileName.value.slice(0, 24) + '…' : cvFileName.value
  })

  function setStatus(msg: string, isError = false) {
    status.value = msg
    statusError.value = isError
  }

  async function send(msg: Msg): Promise<any> {
    return await chrome.runtime.sendMessage(msg)
  }

  async function refreshSettings() {
    const res = await send({ type: 'GHOSTHR_GET_SETTINGS' })
    settings.value = res.settings
    applyTheme()
  }

  const provider = (pid: ProviderId) => settings.value?.providers.find((p) => p.id === pid)

  // ---------- Scan ----------
  async function scanPage() {
    loading.value = true
    setStatus('Scanning page with AI vision…')
    verdict.value = null
    scan.value = null
    try {
      const urlRes = await send({ type: 'GHOSTHR_GET_CURRENT_URL' })
      const res = await send({ type: 'GHOSTHR_SCAN_PAGE' })
      if (res.empty || !res.scan?.jobDescription) {
        setStatus('No job advert detected on this page.', true)
        return
      }
      const s: PageScan = res.scan
      scan.value = s
      scannedUrl.value = urlRes.url ?? ''
      if (s.applyUrl) {
        setStatus('Job advert detected — open the application form to extract fields.')
      } else {
        setStatus(res.offline
          ? `Detected locally (offline) — ${s.fields.length} field(s), no AI needed.`
          : `Scan complete — ${s.fields.length} field(s) extracted.`)
      }
    } catch (e: any) {
      setStatus(`Scan failed: ${e?.message ?? e}`, true)
    } finally {
      loading.value = false
    }
  }

  // ---------- CV upload -> OCR parse ----------
  async function onCvFile(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    cvFileName.value = file.name
    cvKind.value = detectCvKind(file.name, file.type)
    loading.value = true
    setStatus(`Reading ${file.name}…`)
    try {
      const parseMsg: Msg = { type: 'GHOSTHR_PARSE_CV', name: file.name }
      if (cvKind.value === 'image') {
        parseMsg.imageDataUrl = await blobToDataUrl(file)
      } else if (cvKind.value === 'docx') {
        parseMsg.text = await extractDocxText(new Uint8Array(await file.arrayBuffer()))
      } else {
        const text = await extractPdfText(file)
        if (text.trim()) {
          parseMsg.text = text
        } else {
          const [img] = await rasterizePdf(file, 1)
          parseMsg.imageDataUrl = img
        }
      }
      const res = await send(parseMsg)
      if (!res.ok) throw new Error(res.error)
      cv.value = res.cv
      setStatus('CV parsed — ready to autofill.')
    } catch (e: any) {
      setStatus(`CV parse failed: ${e?.message ?? e}`, true)
    } finally {
      loading.value = false
    }
  }

  // ---------- Verdict ----------
  async function runVerdict() {
    if (!scan.value?.jobDescription) {
      setStatus('Scan a page first.', true)
      return
    }
    if (!cv.value) {
      setStatus('Upload your CV first so we can score the match.', true)
      return
    }
    loading.value = true
    try {
      verdict.value = analyze({ jobText: scan.value.jobDescription, cv: cv.value })
      setStatus('Verdict ready.')
    } finally {
      loading.value = false
    }
  }

  // ---------- Autofill ----------
  async function autofill() {
    if (!scan.value?.fields.length || !cv.value) {
      setStatus('Need a scan + CV before autofilling.', true)
      return
    }
    loading.value = true
    try {
      const res = await send({ type: 'GHOSTHR_AUTOFILL', fields: scan.value.fields, cv: cv.value })
      if (res?.ok) setStatus(`Autofilled ${res.filled} field(s).`)
      else setStatus(`Autofill: ${res?.error}`, true)
    } catch (e: any) {
      setStatus(`Autofill failed: ${e?.message ?? e}`, true)
    } finally {
      loading.value = false
    }
  }

  // ---------- Track ----------
  async function trackApplication() {
    if (!scan.value) {
      setStatus('Scan a job before tracking.', true)
      return
    }
    try {
      const res = await send({
        type: 'GHOSTHR_ADD_APPLICATION',
        application: {
          company: scan.value.company || 'Unknown',
          role: scan.value.jobTitle || 'Untitled role',
          job_url: scannedUrl.value || null,
          stage: 'applied',
          notes: JSON.stringify(verdict.value ?? {}),
        },
      })
      setStatus(res.ok ? `Tracked application #${res.id}.` : `Error: ${res.error}`)
      await loadApplications()
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? e}`, true)
    }
  }

  async function loadApplications() {
    const res = await send({ type: 'GHOSTHR_LIST_APPLICATIONS' })
    applications.value = res.applications ?? []
  }

  // Reload the persisted current scan (if any) so fields don't vanish on reopen.
  async function restoreScan() {
    try {
      const res = await send({ type: 'GHOSTHR_GET_CURRENT_SCAN' })
      if (res?.scan) scan.value = res.scan
    } catch {
      /* no persisted scan yet */
    }
  }

  // ---------- Settings ----------
  async function saveSettings() {
    if (!settings.value) return
    await send({ type: 'GHOSTHR_SAVE_SETTINGS', settings: settings.value })
    setStatus('Settings saved.')
  }

  // ---------- First-run setup ----------
  // Non-blocking onboarding: shows once (until setupDone). Must NOT gate on a
  // usable provider, or a user with none configured would be locked out of the
  // whole app and never reach Settings.
  const setupNeeded = computed(() => {
    if (!settings.value) return true // settings not loaded yet -> show setup
    return !settings.value.setupDone
  })

  // Reactive boolean (reacts to setting/provider edits) — unlike the raw
  // function we must NOT expose to templates, where it would always be truthy.
  const hasUsable = computed(() =>
    settings.value ? hasUsableProvider(settings.value) : false,
  )

  async function completeSetup() {
    if (!settings.value) return
    // Always allow completing onboarding. We never block on a usable provider,
    // so Continue always unlocks the app and the user can set up a provider
    // later from the Settings tab.
    settings.value.setupDone = true
    await saveSettings()
    tab.value = 'scan'
    setStatus('Setup complete — you can configure a provider anytime in Settings.')
  }

  // ---------- Theme ----------
  // Apply the current theme preference to the document (system = follow OS).
  const THEME_ATTR = 'data-theme'
  function applyTheme() {
    const pref = settings.value?.theme ?? 'system'
    const resolved =
      pref === 'system'
        ? (typeof window !== 'undefined' &&
          window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light')
        : pref
    document.documentElement.setAttribute(THEME_ATTR, resolved)
  }
  // Listen to OS changes for the 'system' preference.
  const mq = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null
  const onScheme = () => { if (settings.value?.theme === 'system') applyTheme() }
  mq?.addEventListener?.('change', onScheme)

  // Cycle system -> light -> dark -> system. Light is the extension's default
  // visual identity in the popup; system follows the OS.
  const cycleTheme = async () => {
    if (!settings.value) return
    const order: ThemePref[] = ['system', 'light', 'dark']
    const next = order[(order.indexOf(settings.value.theme) + 1) % order.length]
    settings.value.theme = next
    applyTheme()
    await saveSettings()
  }

  // Static fallback options (from the catalog) when dynamic fetch hasn't loaded.
  function staticModels(pid: ProviderId): ModelChoice[] {
    return (PROVIDER_CATALOG[pid]?.models ?? []).map((id) => ({ id, suggested: false }))
  }

  async function loadModelChoices(pid: ProviderId) {
    const p = provider(pid)
    if (!p || !p.baseUrl) return
    // Only fetch the model list for providers the user has actually configured:
    // skip disabled providers, and skip keyless cloud providers (their /models
    // endpoint needs a key, e.g. doubleword returns 401 without one).
    if (!p.enabled) return
    if (pid !== 'local' && !p.apiKey) return
    modelLoading.value = true
    try {
      const choices = await getProviderModels({ provider: pid, baseUrl: p.baseUrl, apiKey: p.apiKey || undefined })
      modelChoices.value[pid] = choices
      // If nothing selected yet (or old default), preselect first suggested vision model.
      const current = p.model
      const suggested = choices.find((c) => c.suggested)
      if (!current || !choices.some((c) => c.id === current)) {
        if (suggested) p.model = suggested.id
        else if (choices[0]) p.model = choices[0].id
      }
    } catch {
      // fall back to catalog defaults (getProviderModels already does)
    } finally {
      modelLoading.value = false
    }
  }

  async function loadAllModelChoices() {
    await Promise.all(providerOrder.map((pid) => loadModelChoices(pid)))
  }

  async function restoreCv() {
    try {
      const res = await send({ type: 'GHOSTHR_GET_CV' })
      // GET_CV returns a stored CvProfile ({ id, name, raw_text, parsed_json });
      // the parsed CV is JSON-encoded in parsed_json. Unwrap it back into the
      // ParsedCv shape the rest of the store/autofill expects.
      const profile: any = res?.cv
      if (profile?.parsed_json) {
        try {
          const parsed: ParsedCv = JSON.parse(profile.parsed_json)
          cv.value = parsed
        } catch {
          // ignore corrupt stored JSON
        }
      }
      cvFileName.value = profile?.name ?? cv.value?.name ?? ''
      cvKind.value = detectCvKind(cvFileName.value, '')
    } catch {
      /* no persisted CV yet */
    }
  }

  let autoScanDone = false

  async function init() {
    await Promise.all([loadApplications(), refreshSettings(), restoreScan(), restoreCv()])
    // NOTE: intentionally do NOT auto-fetch provider model lists on open.
    // The picker already shows models from the static catalog + suggestions,
    // so no network calls are needed at startup. Auto-fetching here hit every
    // provider's /models endpoint on every panel open (e.g. localhost:11434
    // connection-refused when Ollama wasn't running), which made the app feel
    // broken/hang-y. Models are fetched lazily on an explicit "Refresh models".
    //
    // Auto-scan the active page ONCE:
    //  - only after onboarding is completed (setupDone), so the welcome screen
    //    owns first-run
    //  - only when a provider is actually usable (has a key/baseUrl/model)
    //  - fire-and-forget: never blocks init, never hangs the panel
    if (!settings.value?.setupDone) return
    if (!hasUsableProvider(settings.value)) return
    if (autoScanDone) return
    autoScanDone = true
    // run outside the awaited init so the panel mounts immediately
    setTimeout(() => {
      scanPage().catch(() => {})
    }, 0)
  }

  return reactive({
    tab, status, statusError, loading,
    settings, scan, scannedUrl, verdict, cv, cvFileName, cvKind, applications,
    modelChoices, modelLoading, recClass, cvShortName,
    provider, staticModels, hasUsable, cycleTheme,
    refreshSettings, scanPage, onCvFile, runVerdict, autofill, trackApplication,
    loadApplications, restoreScan, saveSettings, loadModelChoices, loadAllModelChoices,
    setupNeeded, completeSetup, init,
  })
}
