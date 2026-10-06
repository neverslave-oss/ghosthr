/**
 * ghostHR popup shared store.
 *
 * Holds all popup state + actions (scan, CV, verdict, applications, settings,
 * dynamic model picker). Extracted from App.vue so each popup file stays well
 * under the project's 400 LOC guideline and the view components stay thin.
 */
import { computed, reactive, ref, watch } from 'vue'
import { analyze, type ParsedCv, type Verdict } from '../ai/verdict'
import { PROVIDER_CATALOG, PROVIDER_ORDER, type ProviderId } from '../ai/providers'
import type { Settings } from '../ai/settings'
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
  // Onboarding removed entirely — the app opens straight to the tabs and
  // providers are configured from the Settings tab.
  async function completeSetup() {}

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

  // Auto-populate each provider's model picker the moment it becomes configured
  // (enabled + key present for cloud) — e.g. a user pasting their API key in the
  // welcome/setup screen should immediately see that provider's models.
  watch(
    () => settings.value?.providers.map((p) => p.id + '|' + p.enabled + '|' + (p.id === 'local' || p.apiKey ? 'k' : '')),
    () => {
      for (const pid of providerOrder) {
        const p = provider(pid)
        if (!p) continue
        const configured = p.enabled && (pid === 'local' || Boolean(p.apiKey))
        if (configured && !modelChoices.value[pid]?.length) {
          loadModelChoices(pid)
        }
      }
    },
    { immediate: true },
  )

  async function init() {
    await Promise.all([loadApplications(), refreshSettings(), restoreScan()])
    await loadAllModelChoices()
  }

  return {
    tab, status, statusError, loading,
    settings, scan, scannedUrl, verdict, cv, cvFileName, cvKind, applications,
    modelChoices, modelLoading, recClass, cvShortName,
    provider, staticModels,
    refreshSettings, scanPage, onCvFile, runVerdict, autofill, trackApplication,
    loadApplications, restoreScan, saveSettings, loadModelChoices, loadAllModelChoices,
    completeSetup, init,
  }
}
