<script setup lang="ts">
import { onMounted, ref } from 'vue'
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

async function send(msg: Msg): Promise<any> {
  return await chrome.runtime.sendMessage(msg)
}

async function refreshSettings() {
  const res = await send({ type: 'GHOSTHR_GET_SETTINGS' })
  settings.value = res.settings
}

// ---------- Scan the page (screenshot -> vision model) ----------
async function scanPageClick() {
  loading.value = true
  status.value = 'Scanning page with AI vision…'
  verdict.value = null
  scan.value = null
  try {
    const urlRes = await send({ type: 'GHOSTHR_GET_CURRENT_URL' })
    const res = await send({ type: 'GHOSTHR_SCAN_PAGE' })
    if (res.empty || !res.scan?.jobDescription) {
      status.value = 'No job advert detected on this page.'
      return
    }
    const s: PageScan = res.scan
    scan.value = s
    scannedUrl.value = urlRes.url ?? ''
    status.value = 'Scan complete — fields extracted.'
  } catch (e: any) {
    status.value = `Scan failed: ${e?.message ?? e}`
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
  status.value = `Reading ${file.name}…`
  try {
    const parseMsg: Msg = { type: 'GHOSTHR_PARSE_CV', name: file.name }
    if (cvKind.value === 'image') {
      parseMsg.imageDataUrl = await blobToDataUrl(file)
    } else if (cvKind.value === 'docx') {
      parseMsg.text = await extractDocxText(new Uint8Array(await file.arrayBuffer()))
    } else {
      // pdf: raw text first, else rasterize for vision OCR
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
    status.value = `CV parsed (${file.name}) — ready to autofill.`
  } catch (e: any) {
    status.value = `CV parse failed: ${e?.message ?? e}`
  } finally {
    loading.value = false
  }
}

// ---------- Verdict (uses the scanned job + parsed CV) ----------
async function runVerdict() {
  if (!scan.value?.jobDescription) {
    status.value = 'Scan a page first.'
    return
  }
  if (!cv.value) {
    status.value = 'Upload your CV first so we can score the match.'
    return
  }
  loading.value = true
  try {
    verdict.value = analyze({ jobText: scan.value.jobDescription, cv: cv.value })
    verdictForTitle.value = scan.value.jobTitle || 'Untitled role'
    status.value = 'Verdict ready.'
  } finally {
    loading.value = false
  }
}

// ---------- Autofill ----------
async function autofill() {
  if (!scan.value?.fields.length || !cv.value) {
    status.value = 'Need a scan + CV before autofilling.'
    return
  }
  loading.value = true
  try {
    const res = await send({
      type: 'GHOSTHR_AUTOFILL',
      fields: scan.value.fields,
      cv: cv.value,
    })
    status.value = res?.ok ? `Autofilled ${res.filled} field(s).` : `Autofill: ${res?.error}`
  } catch (e: any) {
    status.value = `Autofill failed: ${e?.message ?? e}`
  } finally {
    loading.value = false
  }
}

// ---------- Track ----------
async function trackApplication() {
  if (!scan.value) {
    status.value = 'Scan a job before tracking.'
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
    status.value = res.ok ? `Tracked application #${res.id}.` : `Error: ${res.error}`
    await loadApplications()
  } catch (e: any) {
    status.value = `Error: ${e?.message ?? e}`
  }
}

async function loadApplications() {
  const res = await send({ type: 'GHOSTHR_LIST_APPLICATIONS' })
  applications.value = res.applications ?? []
}

async function saveSettings() {
  if (!settings.value) return
  await send({ type: 'GHOSTHR_SAVE_SETTINGS', settings: settings.value })
  status.value = 'Settings saved.'
}

onMounted(async () => {
  await Promise.all([loadApplications(), refreshSettings()])
})
</script>

<template>
  <div class="app">
    <h1>ghost<span>HR</span></h1>
    <div class="tabbar">
      <button :class="{ active: tab === 'scan' }" @click="tab = 'scan'">Scan</button>
      <button :class="{ active: tab === 'track' }" @click="tab = 'track'">Tracked</button>
      <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">Settings</button>
    </div>

    <!-- SCAN -->
    <div v-if="tab === 'scan'">
      <div class="section">
        <button class="primary" :disabled="loading" @click="scanPageClick">Scan job page</button>
        <p class="hint">Captures a screenshot of the current tab and uses your configured vision model to extract the job + form fields.</p>
      </div>

      <div class="section">
        <h2>Your CV <span class="filebadge">{{ cvFileName || 'not loaded' }}</span></h2>
        <input type="file" accept=".pdf,.docx,.doc,.png,.jpg,.jpeg,.webp" @change="onCvFile" />
        <p class="hint">PDF, Word, or image — parsed locally + via your OCR model. Stays on your machine.</p>
      </div>

      <template v-if="scan && scan.jobDescription">
        <div class="section">
          <h2>{{ scan.jobTitle || 'Job' }} <span v-if="scan.company">@ {{ scan.company }}</span></h2>
          <button class="primary" :disabled="loading || !cv" @click="runVerdict">Score match</button>
        </div>

        <div class="section" v-if="scan.fields.length">
          <h2>Fields to fill ({{ scan.fields.length }})</h2>
          <ul class="fieldlist">
            <li v-for="(f, i) in scan.fields" :key="i">
              {{ f.required ? '·' : '○' }} {{ f.label }} <span class="kind">{{ f.kind }}</span>
            </li>
          </ul>
          <button class="primary" :disabled="loading || !cv" @click="autofill">Autofill form</button>
        </div>
      </template>

      <div v-if="verdict" class="verdict" style="margin-top: 12px;">
        <div class="rec">
          <span class="tag" :class="recClass[verdict.recommendation]">{{ verdict.recommendation.replace(/_/g, ' ') }}</span>
          <span style="margin-left: 6px;">{{ verdict.match_score }}/100</span>
        </div>
        <div class="score">Skills {{ verdict.score_breakdown.skills }} · Exp {{ verdict.score_breakdown.experience }} · Fit {{ verdict.score_breakdown.fit_signal }}</div>
        <ul>
          <li v-for="r in verdict.red_flags" :key="r">⚠️ {{ r }}</li>
          <li v-for="(a, i) in verdict.hold_back_actions" :key="'a'+i">▸ <b>{{ a.action }}</b> (~{{ a.est_effort_days }}d): {{ a.detail }}</li>
          <li><i>{{ verdict.reasoning }}</i></li>
        </ul>
        <button class="primary" @click="trackApplication" style="margin-top: 10px;">I applied — track it</button>
      </div>
    </div>

    <!-- TRACKED -->
    <div v-else-if="tab === 'track'">
      <div v-if="!applications.length" class="empty">No applications tracked yet. Scan + apply, then hit "track it".</div>
      <ul v-else style="list-style: none;">
        <li v-for="a in applications" :key="a.id" style="padding: 6px 0; border-bottom: 1px solid #1e293b;">
          <b>{{ a.company }}</b> — {{ a.role }}<br />
          <span class="empty">{{ a.stage }} · {{ a.applied_at }}</span>
        </li>
      </ul>
    </div>

    <!-- SETTINGS -->
    <div v-else-if="tab === 'settings' && settings">
      <div class="section">
        <h2>AI providers</h2>
        <div v-for="pid in providerOrder" :key="pid" class="provider">
          <label class="provhead">
            <input type="checkbox" v-model="settings.providers.find(p => p.id === pid)!.enabled" />
            <b>{{ PROVIDER_CATALOG[pid].label }}</b>
          </label>
          <p class="hint">{{ PROVIDER_CATALOG[pid].description }}</p>
          <input type="text" v-model="settings.providers.find(p => p.id === pid)!.baseUrl" placeholder="Base URL" />
          <input type="password" v-model="settings.providers.find(p => p.id === pid)!.apiKey" :placeholder="PROVIDER_CATALOG[pid].keyLabel" />
          <select v-model="settings.providers.find(p => p.id === pid)!.model">
            <option v-for="m in PROVIDER_CATALOG[pid].models" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
      </div>

      <div class="section">
        <h2>Which model scans the page?</h2>
        <select v-model="settings.scanModel">
          <option v-for="pid in providerOrder" :key="pid" :value="pid">{{ PROVIDER_CATALOG[pid].label }}</option>
        </select>
      </div>

      <div class="section">
        <h2>CV OCR model</h2>
        <select v-model="settings.cvModel">
          <option v-for="pid in providerOrder" :key="pid" :value="pid">{{ PROVIDER_CATALOG[pid].label }}</option>
        </select>
      </div>

      <div class="section">
        <label class="provhead">
          <input type="checkbox" v-model="settings.autofillEnabled" />
          <b>Autofill scanned fields automatically</b>
        </label>
      </div>

      <button class="primary" @click="saveSettings">Save settings</button>
    </div>

    <div v-if="status" class="statusbar">{{ status }}</div>
  </div>
</template>
