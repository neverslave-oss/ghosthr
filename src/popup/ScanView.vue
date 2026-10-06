<script setup lang="ts">
import { usePopupStore, type PopupStore } from './store'

const props = defineProps<{ store: PopupStore }>()
const s = props.store
</script>

<template>
  <main>
    <section class="section">
      <h2><span>Scan the page</span></h2>
      <button class="primary" :disabled="s.loading" @click="s.scanPage">
        <svg v-if="!s.loading" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <span v-else class="spin"></span>
        {{ s.loading && !s.scan ? 'Scanning…' : 'Scan job page' }}
      </button>
      <p class="hint">Captures a screenshot of the current tab and uses your vision model to extract the job + form fields.</p>
    </section>

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
        <li v-for="r in s.verdict.red_flags" :key="r">⚠️ {{ r }}</li>
        <li v-for="(a, i) in s.verdict.hold_back_actions" :key="'a'+i">▸ <b>{{ a.action }}</b> (~{{ a.est_effort_days }}d): {{ a.detail }}</li>
        <li><i>{{ s.verdict.reasoning }}</i></li>
      </ul>
      <button class="primary" @click="s.trackApplication" style="margin-top: 12px;">I applied — track it</button>
    </div>
  </main>
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
