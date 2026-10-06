<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { analyze, type ParsedCv, type Verdict } from '../ai/verdict'
import { mapFieldName, type AthFormField } from '../content/ats'

type Tab = 'scan' | 'track'
type Msg = { type: string; [k: string]: any }

const tab = ref<Tab>('scan')
const jobText = ref('')
const rawCv = ref('')
const verdict = ref<Verdict | null>(null)
const verdictFor = ref('')
const applications = ref<any[]>([])
const status = ref('')
const loading = ref(false)

const recClass: Record<string, string> = {
  apply_now: 'apply_now',
  apply_with_caveats: 'apply_with_caveats',
  hold_back: 'hold_back',
}

async function send(msg: Msg): Promise<any> {
  return await chrome.runtime.sendMessage(msg)
}

function parseCv(raw: string): ParsedCv {
  // Very light heuristic parse: pull bullets with common skill keywords.
  const skills = new Set<string>()
  const known = [
    'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'react', 'vue',
    'node', 'sql', 'postgres', 'docker', 'kubernetes', 'aws', 'terraform',
    'machine learning', 'llm', 'ai', 'data analysis', 'excel',
    'project management', 'agile', 'figma', 'marketing', 'sales', 'seo',
  ]
  const lower = raw.toLowerCase()
  for (const s of known) if (lower.includes(s)) skills.add(s)
  const years = raw.match(/(\d+)\s*\+?\s*(?:years|yrs)/i)?.[1]
  return {
    skills: [...skills],
    years_experience: years ? Number(years) : undefined,
    raw_text: raw,
    projects: lower.includes('project') ? ['listed on CV'] : [],
  }
}

async function runScan() {
  status.value = ''
  if (!jobText.value.trim() || !rawCv.value.trim()) {
    status.value = 'Paste the job description and your CV first.'
    return
  }
  loading.value = true
  try {
    const cv = parseCv(rawCv.value)
    // Phase 1 standalone: local heuristic verdict (provider routing is later).
    verdict.value = analyze({ jobText: jobText.value, cv })
    verdictFor.value = jobText.value.trim().slice(0, 60)
    status.value = 'Verdict ready (local).'
    await send({ type: 'GHOSTHR_SAVE_CV', name: 'cv', rawText: rawCv.value, parsed: cv })
  } catch (e: any) {
    status.value = `Error: ${e?.message ?? e}`
  } finally {
    loading.value = false
  }
}

async function trackApplication() {
  // Persist the current scan as a tracked application.
  const company = (document.title.match(/^(.+?)\s*[-|]\s*/i)?.[1] || 'Unknown').trim()
  const role = verdictFor.value || 'Untitled role'
  try {
    const res = await send({
      type: 'GHOSTHR_ADD_APPLICATION',
      application: { company, role, stage: 'applied', notes: JSON.stringify(verdict.value) },
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

onMounted(async () => {
  await loadApplications()
  try {
    const res = await send({ type: 'GHOSTHR_GET_CV' })
    if (res?.cv?.raw_text) rawCv.value = res.cv.raw_text
  } catch {
    /* db not ready on first load is fine */
  }
})

function fieldForKind(k: AthFormField['kind']): string {
  return k === 'textarea' ? 'textarea' : 'input/select'
}
</script>

<template>
  <div class="app">
    <h1>ghost<span>HR</span></h1>
    <div class="tabbar">
      <button :class="{ active: tab === 'scan' }" @click="tab = 'scan'">Scan</button>
      <button :class="{ active: tab === 'track' }" @click="tab = 'track'">Tracked</button>
    </div>

    <div v-if="tab === 'scan'">
      <div class="section">
        <h2>Job description</h2>
        <textarea v-model="jobText" placeholder="Paste the job description from the ATS page…"></textarea>
      </div>
      <div class="section">
        <h2>Your CV (stays local)</h2>
        <textarea v-model="rawCv" placeholder="Paste or drop your CV text…"></textarea>
      </div>
      <button class="primary" :disabled="loading" @click="runScan">
        {{ loading ? 'Analyzing…' : 'Scan job' }}
      </button>

      <div v-if="verdict" class="verdict" style="margin-top: 12px;">
        <div class="rec">
          <span class="tag" :class="recClass[verdict.recommendation]">
            {{ verdict.recommendation.replace(/_/g, ' ') }}
          </span>
          <span style="margin-left: 6px;">{{ verdict.match_score }}/100</span>
        </div>
        <div class="score">Skills {{ verdict.score_breakdown.skills }} · Exp {{ verdict.score_breakdown.experience }} · Fit {{ verdict.score_breakdown.fit_signal }}</div>
        <ul>
          <li v-for="r in verdict.red_flags" :key="r">⚠️ {{ r }}</li>
          <li v-if="verdict.gap_analysis.length" v-for="g in verdict.gap_analysis" :key="g">• {{ g }}</li>
          <li v-for="(a, i) in verdict.hold_back_actions" :key="i">
            ▸ <b>{{ a.action }}</b> (~{{ a.est_effort_days }}d): {{ a.detail }}
          </li>
          <li><i>{{ verdict.reasoning }}</i></li>
        </ul>
        <button class="primary" @click="trackApplication" style="margin-top: 10px;">I applied — track it</button>
      </div>
    </div>

    <div v-else>
      <div class="section">
        <h2>Tracked applications</h2>
        <div v-if="!applications.length" class="empty">No applications tracked yet. Scan a job and hit "track it".</div>
        <ul v-else style="list-style: none;">
          <li v-for="a in applications" :key="a.id" style="padding: 6px 0; border-bottom: 1px solid #1e293b;">
            <b>{{ a.company }}</b> — {{ a.role }}<br />
            <span class="empty">{{ a.stage }} · {{ a.applied_at }}</span>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="status" style="font-size: 12px; color: #38bdf8; margin-top: 8px;">{{ status }}</div>
  </div>
</template>
