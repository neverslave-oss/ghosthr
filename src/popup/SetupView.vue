<script setup lang="ts">
import { providerOrder, type PopupStore } from './store'
import { PROVIDER_CATALOG } from '../ai/providers'

const props = defineProps<{ store: PopupStore; dismiss: () => void }>()
const s = props.store
</script>

<template>
  <main class="setup" v-if="s.settings">
    <section class="section">
      <h2><span>👋 Welcome to ghostHR</span></h2>
      <p class="hint">
        To scan job pages and autofill applications, ghostHR needs at least one AI
        provider configured. Enable one and (for cloud providers) paste your API key,
        then pick a model. Your chosen Scan model is used to read the page.
      </p>

      <div v-for="pid in providerOrder" :key="pid" class="provider" v-if="s.provider(pid)">
        <label class="provhead">
          <input type="checkbox" v-model="s.provider(pid)!.enabled" />
          <b>{{ PROVIDER_CATALOG[pid].label }}</b>
        </label>
        <p class="hint">{{ PROVIDER_CATALOG[pid].description }}</p>
        <template v-if="s.provider(pid)!.enabled">
          <label class="field-label">Base URL</label>
          <input type="text" v-model="s.provider(pid)!.baseUrl" placeholder="Base URL" />
          <label class="field-label">{{ PROVIDER_CATALOG[pid].keyLabel }}</label>
          <input type="password" v-model="s.provider(pid)!.apiKey" :placeholder="PROVIDER_CATALOG[pid].keyLabel" />
          <label class="field-label">Model</label>
          <select v-model="s.provider(pid)!.model">
            <option v-for="m in (s.modelChoices[pid]?.length ? s.modelChoices[pid] : s.staticModels(pid))"
              :key="m.id" :value="m.id">
              {{ m.id }}{{ m.suggested ? ' ★ recommended' : '' }}
            </option>
          </select>
        </template>
      </div>

      <button class="primary" @click="dismiss">Continue</button>
      <p class="hint" style="margin-top:8px">
        {{ s.hasUsable ? 'Great — a usable provider is configured.' : 'No provider configured yet — you can add one anytime in Settings.' }}
      </p>
      <button class="ghost small" style="margin-top:10px" @click="dismiss">Skip for now</button>
    </section>
  </main>
</template>
