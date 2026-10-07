<script setup lang="ts">
import { ref } from 'vue'
import { usePopupStore, type PopupStore } from './store'

const props = defineProps<{ store: PopupStore }>()
const s = props.store

// [view raw] collapsible sections — raw text + parsed JSON per item.
const showRawScan = ref(false)
const showRawCv = ref(false)
const rawCvId = ref<number | null>(null)

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
</script>

<template>
  <main>
    <section class="section">
      <h2><span>Scan the page</span></h2>
      <button class="primary" :disabled="s.loading" @click="s.scanPage(true)">
        <svg v-if="!s.loading" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <span v-else class="spin"></span>
        {{ s.loading && !s.scan ? 'Scanning…' : s.scan?.jobDescription ? 'Re-scan job page' : 'Scan job page' }}
      </button>
      <p class="hint">Captures a screenshot of the current tab and uses your vision model to extract the job + form fields. Returning to a previously-parsed advert reuses the saved scan — hit "Re-scan" to force a fresh parse.</p>
    </section>

    <!-- Your CV card: upload + list all saved CVs, pick the active one, view raw. -->
    <section class="section">
      <h2>Your CV <span class="sub" :class="s.cv ? 'cv-loaded' : ''">{{ s.cv ? '✓ loaded' : '' }}</span></h2>
      <label class="file-upload">
        <span class="file-icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>
        </span>
        <span class="file-meta">
          <span class="file-name">{{ s.cvShortName }}</span>
          <span class="file-action">{{ s.cvFileName ? 'Click to replace CV' : 'Upload PDF, Word or image' }}</span>
        </span>
        <span v-if="s.cvFileName" class="file-badge">{{ s.cvKind }}</span>
        <input type="file" accept=".pdf,.docx,.doc,.png,.jpg,.jpeg,.webp" @change="s.onCvFile" />
      </label>
      <p class="hint">Parsed locally + via your OCR model. Stays on your machine.</p>

      <!-- All saved CVs — click one to score against it. -->
      <div v-if="s.cvList.length" class="cv-list">
        <div class="cv-list-title">Choose which CV to match against</div>
        <button
          v-for="p in s.cvList"
          :key="p.id"
          class="cv-row"
          :class="{ active: p.id === s.activeCvId || (s.activeCvId == null && p.id === s.activeCvProfile()?.id) }"
          @click="s.selectCv(p)"
        >
          <span class="cv-name">{{ p.name || `CV #${p.id}` }}</span>
          <span class="cv-date">{{ new Date(p.created_at).toLocaleDateString() }}</span>
          <span class="cv-active" v-if="p.id === s.activeCvId || (s.activeCvId == null && p.id === s.activeCvProfile()?.id)">✓ active</span>
        </button>
      </div>

      <button v-if="s.cv" class="ghost small" style="margin-top:8px" @click="showRawCv = !showRawCv">
        {{ showRawCv ? '[hide raw]' : '[view raw]' }}
      </button>
      <div v-if="showRawCv" class="raw-block">
        <div class="raw-label">Parsed JSON (what the model sees)</div>
        <pre>{{ s.cv ? prettyJson(s.cv) : '' }}</pre>
        <template v-if="s.activeCvProfile()">
          <div class="raw-label">Raw text stored for this CV</div>
          <pre>{{ s.activeCvProfile()!.raw_text || '(none)' }}</pre>
        </template>
      </div>
    </section>

    <template v-if="s.scan && s.scan.jobDescription">
      <section class="section">
        <h2><span>Job</span></h2>
        <div class="job-title">{{ s.scan.jobTitle || 'Untitled role' }}</div>
        <div v-if="s.scan.company" class="job-company">{{ s.scan.company }}</div>
        <button class="primary" :disabled="s.loading || !s.cv" @click="s.runVerdict">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.7 6 .4-4.6 3.9 1.4 5.9L12 15.9 7.3 19l1.4-5.9L4 9.1l6-.4z"/></svg>
          Score my fit
        </button>
        <button class="ghost small" style="margin-top:8px" @click="showRawScan = !showRawScan">
          {{ showRawScan ? '[hide raw]' : '[view raw]' }}
        </button>
        <div v-if="showRawScan" class="raw-block">
          <div class="raw-label">Job description (raw)</div>
          <pre>{{ s.scan.jobDescription }}</pre>
          <div class="raw-label">Parsed fields (JSON)</div>
          <pre>{{ prettyJson(s.scan.fields) }}</pre>
        </div>
      </section>

      <section class="section" v-if="s.scan.fields.length">
        <h2><span>Fields to fill ({{ s.scan.fields.length }})</span></h2>
        <ul class="fieldlist">
          <li v-for="(f, i) in s.scan.fields" :key="i">
            <span class="dot">{{ f.required ? '●' : '○' }}</span>
            <span class="lbl">{{ f.label }}</span>
            <span class="kind">{{ f.kind }}</span>
          </li>
        </ul>
        <button class="primary" :disabled="s.loading || !s.cv" @click="s.autofill">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          Autofill form
        </button>
      </section>
    </template>

    <div v-if="s.verdict" class="verdict">
      <div class="rec">
        <span class="rec-score" :class="s.recClass[s.verdict.recommendation]">{{ s.verdict.recommendation.replace(/_/g, ' ') }}</span>
        <span class="match">{{ s.verdict.match_score }}/100</span>
      </div>
      <div class="score">Skills {{ s.verdict.score_breakdown.skills }} · Exp {{ s.verdict.score_breakdown.experience }} · Fit {{ s.verdict.score_breakdown.fit_signal }}</div>
      <ul>
        <li v-for="r in s.verdict.red_flags" :key="r" class="flag">⚠️ {{ r }}</li>
        <!-- Hold-back card: type label + effort + full detail per action. -->
        <li v-for="(a, i) in s.verdict.hold_back_actions" :key="'a'+i" class="holdback">
          <div class="hb-head">
            <span class="hb-type" :class="'type-' + a.action">{{ a.action }}</span>
            <span class="hb-effort">~{{ a.est_effort_days }}d effort</span>
          </div>
          <div class="hb-detail">{{ a.detail }}</div>
        </li>
        <li class="reason"><i>{{ s.verdict.reasoning }}</i></li>
      </ul>
      <button class="primary" @click="s.trackApplication" style="margin-top: 12px;">I applied — track it</button>
    </div>
  </main>
</template>

<style scoped>
.job-title { font-size: 15px; font-weight: 700; color: var(--ink); margin-bottom: 2px; }
.job-company { font-size: 12.5px; color: var(--ink-dim); margin-bottom: 12px; }
.match { font-size: 15px; font-weight: 800; color: var(--ink); }
.cv-loaded { color: var(--ok); }
.spin {
  width: 15px; height: 15px;
  border: 2px solid rgba(6, 18, 31, 0.35);
  border-top-color: #06121f;
  border-radius: 50%;
  animation: sp 0.8s linear infinite;
  display: inline-block;
}
@keyframes sp { to { transform: rotate(360deg); } }

/* --- multi-CV picker --- */
.cv-list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.cv-list-title { font-size: 10.5px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; margin-bottom: 4px; }
.cv-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  font-size: 12.5px; cursor: pointer; text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.cv-row:hover { border-color: var(--accent-1); }
.cv-row.active { border-color: var(--accent-1); background: rgba(56, 189, 248, 0.12); }
.cv-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-date { margin-left: auto; flex: none; color: var(--ink-faint); font-size: 11px; }
.cv-active { flex: none; color: var(--accent-1); font-size: 11px; font-weight: 700; }

/* --- [view raw] blocks --- */
.raw-block { margin-top: 10px; }
.raw-label { font-size: 10px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; margin: 8px 0 4px; }
.raw-block pre {
  background: var(--input-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 10.5px; line-height: 1.45;
  color: var(--ink-dim);
  white-space: pre-wrap; word-break: break-word;
  max-height: 180px; overflow: auto;
}

/* --- hold-back card --- */
.verdict li.holdback { display: flex; flex-direction: column; gap: 4px; }
.hb-head { display: flex; align-items: center; gap: 8px; }
.hb-type {
  font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 2px 8px; border-radius: 20px;
}
.hb-type.type-study { background: rgba(56, 189, 248, 0.16); color: var(--accent-1); }
.hb-type.type-portfolio { background: rgba(129, 140, 248, 0.16); color: var(--accent-2); }
.hb-type.type-reframe { background: rgba(251, 191, 36, 0.16); color: var(--warn); }
.hb-type.type-network { background: rgba(52, 211, 153, 0.16); color: var(--ok); }
.hb-type.type-build { background: rgba(248, 113, 113, 0.16); color: var(--bad); }
.hb-effort { margin-left: auto; color: var(--ink-dim); font-weight: 700; font-size: 11px; }
.hb-detail { font-size: 12px; line-height: 1.5; color: var(--ink); }
.verdict li.flag { color: var(--warn); }
.verdict li.reason { font-style: italic; }
button.ghost.small { width: auto; padding: 6px 12px; font-size: 12px; }
</style>
