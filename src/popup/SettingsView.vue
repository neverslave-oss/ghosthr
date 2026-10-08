<script setup lang="ts">
import { providerOrder, type PopupStore } from './store'
import { PROVIDER_CATALOG } from '../ai/providers'

const props = defineProps<{ store: PopupStore }>()
const s = props.store
</script>

<template>
  <main v-if="s.settings">
    <section class="section">
      <h2><span>AI providers</span></h2>
      <!-- NOTE: v-if and v-for CANNOT be on the same element — v-if has higher
           precedence, so pid is out of scope and every card would be skipped.
           Use a <template v-for> wrapper with the v-if inside. -->
      <template v-for="pid in providerOrder" :key="pid">
        <div class="provider" v-if="s.provider(pid)">
          <label class="provhead">
            <input type="checkbox" v-model="s.provider(pid)!.enabled" />
            <b>{{ PROVIDER_CATALOG[pid].label }}</b>
          </label>
          <p class="hint">{{ PROVIDER_CATALOG[pid].description }}</p>
          <label class="field-label">Base URL</label>
          <input type="text" v-model="s.provider(pid)!.baseUrl" placeholder="Base URL" />
          <label class="field-label">{{ PROVIDER_CATALOG[pid].keyLabel }}</label>
          <input type="password" v-model="s.provider(pid)!.apiKey" :placeholder="PROVIDER_CATALOG[pid].keyLabel" />
          <label class="field-label">Model {{ s.modelLoading ? '(loading…)' : '' }}</label>
          <!-- modelOptions always includes the persisted model; @change saves
               immediately so the choice survives restarts without "Save settings". -->
          <select v-model="s.provider(pid)!.model" @change="s.saveSettings()">
            <option v-for="m in s.modelOptions(pid)"
              :key="m.id" :value="m.id">
              {{ m.id }}{{ m.suggested ? ' ★ recommended' : '' }}
            </option>
          </select>
          <button v-if="s.provider(pid)!.baseUrl" class="ghost small" style="margin-top:8px" @click="s.loadModelChoices(pid)">Refresh models</button>
          <p class="hint" style="margin-top:6px">★ = recommended for ghostHR tasks. List fetches once and is cached.</p>
        </div>
      </template>
    </section>

    <section class="section">
      <h2><span>Scan model</span></h2>
      <p class="hint">Which provider scans the page for job + form fields.</p>
      <select v-model="s.settings!.scanModel">
        <option v-for="pid in providerOrder" :key="pid" :value="pid">{{ PROVIDER_CATALOG[pid].label }}</option>
      </select>
    </section>

    <section class="section">
      <h2><span>CV OCR model</span></h2>
      <p class="hint">Which provider reads and extracts your CV.</p>
      <select v-model="s.settings!.cvModel">
        <option v-for="pid in providerOrder" :key="pid" :value="pid">{{ PROVIDER_CATALOG[pid].label }}</option>
      </select>
    </section>

    <section class="section">
      <label class="provhead">
        <input type="checkbox" v-model="s.settings!.autofillEnabled" />
        <b>Autofill scanned fields automatically</b>
      </label>
    </section>

    <button class="primary" @click="s.saveSettings">Save settings</button>

    <p class="dev-credit">
      Developed by <a href="https://neverslave.com" target="_blank" rel="noopener"><b>Fab</b> at neverslave.com</a>
    </p>
  </main>
</template>

<style scoped>
.dev-credit {
  margin-top: 14px; text-align: center; font-size: 11px; color: var(--ink-faint);
}
.dev-credit a { color: var(--ink-dim); text-decoration: none; }
.dev-credit a:hover { color: var(--accent-1); }
</style>
