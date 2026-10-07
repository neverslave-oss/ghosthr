/**
 * ghostHR popup shared store.
 *
 * Holds all popup state + actions (scan, CV, verdict, applications, settings,
 * dynamic model picker). Extracted from App.vue so each popup file stays well
 * under the project's 400 LOC guideline and the view components stay thin.
 */
import { computed, reactive, ref } from 'vue'
import { analyze, type ParsedCv, type Verdict } from '../ai/verdict'
import type { CvProfile } from '../db'
import { PROVIDER_CATALOG, PROVIDER_ORDER, routeLlm, type ProviderId } from '../ai/providers'
import { hasUsableProvider, type Settings, type ThemePref } from '../ai/settings'
import { getProviderModels, type ModelChoice } from '../ai/models'
import type { PageScan } from '../ai/scanner'
import { detectCvKind, blobToDataUrl, extractDocxText, type CvFileKind } from '../ai/cvocr'
import { extractPdfText, rasterizePdf } from '../ai/pdftools'
import { cvValueBag, resolveFieldValue } from '../content/autofill'
import { generateFieldValues, type GeneratedField } from '../ai/genfill'

export type Tab = 'scan' | 'track' | 'settings' | 'agent'
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

  // Multi-CV support: every saved profile + which one is active for scoring.
  const cvList = ref<CvProfile[]>([])
  const activeCvId = ref<number | null>(null)

  // Tracked
  const applications = ref<any[]>([])

  // Agent chat (extension Agent tab)
  const agentMessages = ref<{ role: 'user' | 'assistant'; text: string }[]>([])
  const agentBusy = ref(false)
  // 'desktop' | 'standalone' | '' (empty until first send)
  const agentMode = ref('')

  // Desktop deep-agent loopback bridge. When ghostHR is loaded inside the
  // Electron desktop app, the desktop main process exposes the full LangGraph
  // agent here. Standalone browser usage falls back to our own provider chat.
  const AGENT_BRIDGE = 'http://127.0.0.1:18977'

  async function desktopAgentHealth(): Promise<boolean> {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 1200)
      const res = await fetch(`${AGENT_BRIDGE}/agent/health`, { signal: ctl.signal })
      clearTimeout(t)
      if (!res.ok) return false
      const j = await res.json()
      return !!j?.ok
    } catch {
      return false
    }
  }

  function buildStandaloneSystemPrompt(): string {
    const s = scan.value
    const c = cv.value
    const parts: string[] = [
      'You are ghostHR\u2019s job-coach agent. Help the user decide about a job\n' +
      'application, score their fit, and give actionable next steps. Be honest,' +
      'specific and concise.',
    ]
    if (s?.jobDescription) {
      parts.push(
        `Current job scan (${s.jobTitle || 'untitled'}${s.company ? ' at ' + s.company : ''}):\n` +
          s.jobDescription.slice(0, 1200),
      )
    } else {
      parts.push('No job scanned yet \u2014 tell the user to scan a job page first for fit scoring.')
    }
    if (c) {
      const skills = c.skills?.length ? c.skills.join(', ') : '(none listed)'
      const years = c.years_experience ?? 'unknown'
      const projects = c.projects?.length ? c.projects.join('; ') : '(none)'
      parts.push(`Candidate CV: skills=[${skills}] years=${years} projects=[${projects}]`)
    }
    return parts.join('\n\n')
  }

  // Send one user message to the agent. Prefers the desktop deep agent (if
  // this extension is running inside the desktop app); otherwise falls back to
  // the standalone provider chat via the same routing as every other AI call.
  async function sendAgent(text: string): Promise<void> {
    const message = text.trim()
    if (!message || agentBusy.value) return
    agentBusy.value = true
    agentMessages.value.push({ role: 'user', text: message })
    const placeholder = { role: 'assistant' as const, text: '…' }
    agentMessages.value.push(placeholder)

    try {
      const useDesktop = await desktopAgentHealth()
      if (useDesktop) {
        agentMode.value = 'desktop'
        const res = await fetch(`${AGENT_BRIDGE}/agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        })
        const j = await res.json().catch(() => ({}))
        if (!j?.ok) throw new Error(j?.error || 'desktop agent error')
        placeholder.text = j.text || '(empty reply)'
        return
      }

      // Standalone fallback: route through the configured providers, reusing
      // the exact context the desktop deep agent sees.
      agentMode.value = 'standalone'
      if (!settings.value || !hasUsableProvider(settings.value)) {
        throw new Error('No usable AI provider configured. Open Settings to add one.')
      }
      const providers = settings.value.providers
        .filter((p) => p.enabled)
        .map((p) => ({ id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }))
      const res2 = await routeLlm(providers as any, (pid: ProviderId) => [
        { role: 'system' as const, content: buildStandaloneSystemPrompt() },
        ...agentMessages.value
          .filter((m) => m !== placeholder)
          .map((m) => ({ role: m.role, content: m.text })),
      ])
      placeholder.text = res2.result.text.trim() || '(empty reply)'
    } catch (e: any) {
      placeholder.text = `⚠️ ${e?.message ?? e}`
    } finally {
      agentBusy.value = false
    }
  }

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
  // force=true re-parses the page even if a cached scan exists for that URL.
  async function scanPage(force = false) {
    loading.value = true
    setStatus(force ? 'Re-scanning page…' : (scan.value && scan.value.jobDescription ? 'Reloading cached scan…' : 'Scanning page with AI vision…'))
    verdict.value = null
    scan.value = null
    try {
      const urlRes = await send({ type: 'GHOSTHR_GET_CURRENT_URL' })
      const url = urlRes.url ?? ''
      const res = await send({ type: 'GHOSTHR_SCAN_PAGE', force, url })
      if (res.empty || !res.scan?.jobDescription) {
        setStatus('No job advert detected on this page.', true)
        return
      }
      const s: PageScan = res.scan
      scan.value = s
      scannedUrl.value = url
      if (res.cached) {
        setStatus('Loaded previously-parsed scan for this URL.')
      } else if (s.applyUrl) {
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
      // The just-uploaded CV becomes the active one for "score my fit" AND is
      // persisted (upsertCvProfile marks it active) so it survives reopen.
      await loadCvList()
      activeCvId.value = res.id ?? null
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

  async function loadCvList() {
    const res = await send({ type: 'GHOSTHR_LIST_CV' })
    cvList.value = res.profiles ?? []
  }

  /** The currently-active CvProfile row (if any). */
  function activeCvProfile(): CvProfile | null {
    return cvList.value.find((p) => p.id === activeCvId.value) ?? cvList.value[0] ?? null
  }

  /** Load a chosen CV into cv.value and mark it active in the DB. */
  async function selectCv(profile: CvProfile) {
    await send({ type: 'GHOSTHR_SET_ACTIVE_CV', id: profile.id })
    activeCvId.value = profile.id
    try {
      const parsed: ParsedCv = JSON.parse(profile.parsed_json)
      cv.value = parsed
    } catch {
      cv.value = null
    }
    cvFileName.value = profile.name ?? ''
    cvKind.value = detectCvKind(cvFileName.value, '')
    setStatus(`Active CV set to ${profile.name || `#${profile.id}`}.`)
    // Keep the list in sync (active flags updated server-side).
    await loadCvList()
  }

  // ---------- Autofill ----------
  async function autofill() {
    if (!scan.value?.fields.length || !cv.value) {
      setStatus('Need a scan + CV before autofilling.', true)
      return
    }
    loading.value = true
    try {
      // 1. Deterministic CV fields fill instantly (no model round-trip).
      // 2. The agent then generates values for every field the CV can't
      //    provide directly (textareas, custom questions, cover letter, etc.)
      //    and those are filled too — one click, everything populated.
      const covered = new Set<string>()
      for (const f of scan.value.fields) {
        if (resolveFieldValue(f, cvValueBag(cv.value))) covered.add(f.label)
      }
      const toGenerate = scan.value.fields.filter((f) => !covered.has(f.label) && f.kind !== 'checkbox')

      let generated: GeneratedField[] = []
      if (settings.value && toGenerate.length) {
        generated = await generateFieldValues({
          settings: settings.value,
          cv: cv.value,
          jobDescription: scan.value.jobDescription || '',
          fields: toGenerate,
        })
      }

      const res = await send({
        type: 'GHOSTHR_AUTOFILL',
        fields: scan.value.fields,
        cv: cv.value,
        generated,
      })
      if (res?.ok) {
        const genN = generated.length
        setStatus(`Autofilled ${res.filled} field(s)${genN ? ` (${genN} AI-generated)` : ''}.`)
      } else setStatus(`Autofill: ${res?.error}`, true)
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
      const [listRes, res] = await Promise.all([
        send({ type: 'GHOSTHR_LIST_CV' }),
        send({ type: 'GHOSTHR_GET_CV' }),
      ])
      cvList.value = listRes.profiles ?? []
      // GET_CV returns the ACTIVE profile (falls back to latest pre-flag).
      const profile: any = res?.cv
      if (profile?.parsed_json) {
        try {
          const parsed: ParsedCv = JSON.parse(profile.parsed_json)
          cv.value = parsed
        } catch {
          // ignore corrupt stored JSON
        }
      }
      activeCvId.value = profile?.id ?? cvList.value[0]?.id ?? null
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
    cvList, activeCvId, activeCvProfile, loadCvList, selectCv,
    modelChoices, modelLoading, recClass, cvShortName,
    agentMessages, agentBusy, agentMode,
    provider, staticModels, hasUsable, cycleTheme,
    refreshSettings, scanPage, onCvFile, runVerdict, autofill, trackApplication,
    loadApplications, restoreScan, saveSettings, loadModelChoices, loadAllModelChoices,
    setupNeeded, completeSetup, init, sendAgent,
  })
}
