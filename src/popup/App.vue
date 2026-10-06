<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { analyze, type ParsedCv, type Verdict } from '../ai/verdict'
import { PROVIDER_CATALOG, PROVIDER_ORDER, type ProviderId } from '../ai/providers'
import type { Settings } from '../ai/settings'
import type { PageScan, ScannedField } from '../ai/scanner'
import { detectCvKind, blobToDataUrl, extractDocxText, type CvFileKind } from '../ai/cvocr'
import { extractPdfText, rasterizePdf } from '../ai/pdftools'

type Tab = 'scan' | 'track' | 'settings'
type Msg = { type: string; [k: string]: any }

const tab = ref<Tab>('scan')
const status = ref('')
const statusError = ref(false)
const loading = ref(false)

// Settings
const settings = ref<Settings | null>(null)
const providerOrder = PROVIDER_ORDER

// Scan results
const scan = ref<PageScan | null>(null)
const scannedUrl = ref('')
const verdict = ref<Verdict | null>(null)
const verdictForTitle = ref('')

// CV (file upload)
const cv = ref<ParsedCv | null>(null)
const cvFileName = ref('')
const cvKind = ref<CvFileKind>('pdf')

// Tracked
const applications = ref<any[]>([])

const recClass: Record<string, string> = {
  apply_now: 'apply_now',
  apply_with_caveats: 'apply_with_caveats',
  hold_back: 'hold_back',
}

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

const cvShortName = computed(() => {
  if (!cvFileName.value) return 'No CV loaded'
  return cvFileName.value.length > 26 ? cvFileName.value.slice(0, 24) + '…' : cvFileName.value
})

// ---------- Scan the page (screenshot -> vision model) ----------
async function scanPageClick() {
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
    setStatus(`CV parsed — ready to autofill.`)
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
    verdictForTitle.value = scan.value.jobTitle || 'Untitled role'
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

async function saveSettings() {
  if (!settings.value) return
  await send({ type: 'GHOSTHR_SAVE_SETTINGS', settings: settings.value })
  setStatus('Settings saved.')
}

const provider = (pid: ProviderId) => settings.value?.providers.find((p) => p.id === pid)

onMounted(async () => {
  await Promise.all([loadApplications(), refreshSettings(), restoreScan()])
})
</script>

<template>
  <div class="app">
    <header class="brand">
      <div class="brand-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <div>
        <div class="brand-title">ghost<span>HR</span></div>
        <div class="brand-sub">AI job scout</div>
      </div>
    </header>

    <nav class="tabbar">
      <button :class="{ active: tab === 'scan' }" @click="tab = 'scan'">Scan</button>
      <button :class="{ active: tab === 'track' }" @click="tab = 'track'">Tracked</button>
      <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">Settings</button>
    </nav>

    <!-- SCAN -->
    <main v-if="tab === 'scan'">
      <section class="section">
        <h2><span>Scan the page</span></h2>
        <button class="primary" :disabled="loading" @click="scanPageClick">
          <svg v-if="!loading" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <span v-else class="spin"></span>
          {{ loading && !scan ? 'Scanning…' : 'Scan job page' }}
        </button>
        <p class="hint">Captures a screenshot of the current tab and uses your vision model to extract the job + form fields.</p>
      </section>

      <section class="section">
        <h2>Your CV <span class="sub" :class="cv ? 'cv-loaded' : ''">{{ cv ? '✓ loaded' : '' }}</span></h2>
        <label class="file-upload">
          <span class="file-icon">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>
          </span>
          <span class="file-meta">
            <span class="file-name">{{ cvShortName }}</span>
            <span class="file-action">{{ cvFileName ? 'Click to replace CV' : 'Upload PDF, Word or image' }}</span>
          </span>
          <span v-if="cvFileName" class="file-badge">{{ cvKind }}</span>
          <input type="file" accept=".pdf,.docx,.doc,.png,.jpg,.jpeg,.webp" @change="onCvFile" />
        </label>
        <p class="hint">Parsed locally + via your OCR model. Stays on your machine.</p>
      </section>

      <template v-if="scan && scan.jobDescription">
        <section class="section">
          <h2><span>Job</span></h2>
          <div class="job-title">{{ scan.jobTitle || 'Untitled role' }}</div>
          <div v-if="scan.company" class="job-company">{{ scan.company }}</div>
          <button class="primary" :disabled="loading || !cv" @click="runVerdict">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.7 6 .4-4.6 3.9 1.4 5.9L12 15.9 7.3 19l1.4-5.9L4 9.1l6-.4z"/></svg>
            Score my fit
          </button>
        </section>

        <section class="section" v-if="scan.fields.length">
          <h2><span>Fields to fill ({{ scan.fields.length }})</span></h2>
          <ul class="fieldlist">
            <li v-for="(f, i) in scan.fields" :key="i">
              <span class="dot">{{ f.required ? '●' : '○' }}</span>
              <span class="lbl">{{ f.label }}</span>
              <span class="kind">{{ f.kind }}</span>
            </li>
          </ul>
          <button class="primary" :disabled="loading || !cv" @click="autofill">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            Autofill form
          </button>
        </section>
      </template>

      <div v-if="verdict" class="verdict">
        <div class="rec">
          <span class="rec-score" :class="recClass[verdict.recommendation]">{{ verdict.recommendation.replace(/_/g, ' ') }}</span>
          <span class="match">{{ verdict.match_score }}/100</span>
        </div>
        <div class="score">Skills {{ verdict.score_breakdown.skills }} · Exp {{ verdict.score_breakdown.experience }} · Fit {{ verdict.score_breakdown.fit_signal }}</div>
        <ul>
          <li v-for="r in verdict.red_flags" :key="r">⚠️ {{ r }}</li>
          <li v-for="(a, i) in verdict.hold_back_actions" :key="'a'+i">▸ <b>{{ a.action }}</b> (~{{ a.est_effort_days }}d): {{ a.detail }}</li>
          <li><i>{{ verdict.reasoning }}</i></li>
        </ul>
        <button class="primary" @click="trackApplication" style="margin-top: 12px;">I applied — track it</button>
      </div>
    </main>

    <!-- TRACKED -->
    <main v-else-if="tab === 'track'">
      <div v-if="!applications.length" class="empty">No applications tracked yet.<br />Scan a job, apply, then hit "track it".</div>
      <ul v-else class="track-list">
        <li v-for="a in applications" :key="a.id">
          <div class="co">{{ a.company }}</div>
          <div class="role">{{ a.role }}</div>
          <div class="meta">
            <span class="stage-pill">{{ a.stage }}</span>
            <span>{{ new Date(a.applied_at).toLocaleDateString() }}</span>
          </div>
        </li>
      </ul>
    </main>

    <!-- SETTINGS -->
    <main v-else-if="tab === 'settings' && settings">
      <section class="section">
        <h2><span>AI providers</span></h2>
        <div v-for="pid in providerOrder" :key="pid" class="provider">
          <label class="provhead">
            <input type="checkbox" v-model="provider(pid)!.enabled" />
            <b>{{ PROVIDER_CATALOG[pid].label }}</b>
          </label>
          <p class="hint">{{ PROVIDER_CATALOG[pid].description }}</p>
          <label class="field-label">Base URL</label>
          <input type="text" v-model="provider(pid)!.baseUrl" placeholder="Base URL" />
          <label class="field-label">{{ PROVIDER_CATALOG[pid].keyLabel }}</label>
          <input type="password" v-model="provider(pid)!.apiKey" :placeholder="PROVIDER_CATALOG[pid].keyLabel" />
          <label class="field-label">Model</label>
          <select v-model="provider(pid)!.model">
            <option v-for="m in PROVIDER_CATALOG[pid].models" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
      </section>

      <section class="section">
        <h2><span>Scan model</span></h2>
        <p class="hint">Which provider scans the page for job + form fields.</p>
        <select v-model="settings.scanModel">
          <option v-for="pid in providerOrder" :key="pid" :value="pid">{{ PROVIDER_CATALOG[pid].label }}</option>
        </select>
      </section>

      <section class="section">
        <h2><span>CV OCR model</span></h2>
        <p class="hint">Which provider reads and extracts your CV.</p>
        <select v-model="settings.cvModel">
          <option v-for="pid in providerOrder" :key="pid" :value="pid">{{ PROVIDER_CATALOG[pid].label }}</option>
        </select>
      </section>

      <section class="section">
        <label class="provhead">
          <input type="checkbox" v-model="settings.autofillEnabled" />
          <b>Autofill scanned fields automatically</b>
        </label>
      </section>

      <button class="primary" @click="saveSettings">Save settings</button>
    </main>

    <div v-if="status" class="statusbar" :class="{ error: statusError }">{{ status }}</div>
  </div>
</template>

<style scoped>
.job-title { font-size: 15px; font-weight: 700; color: var(--ink); margin-bottom: 2px; }
.job-company { font-size: 12.5px; color: var(--ink-dim); margin-bottom: 12px; }
.match { font-size: 15px; font-weight: 800; color: var(--ink); }
.cv-loaded { color: #34d399; }
.spin {
  width: 15px; height: 15px;
  border: 2px solid rgba(6, 18, 31, 0.35);
  border-top-color: #06121f;
  border-radius: 50%;
  animation: sp 0.8s linear infinite;
  display: inline-block;
}
@keyframes sp { to { transform: rotate(360deg); } }
</style>
