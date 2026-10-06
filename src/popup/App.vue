<script setup lang="ts">
import { onMounted } from 'vue'
import { usePopupStore, type PopupStore } from './store'
import ScanView from './ScanView.vue'
import TrackView from './TrackView.vue'
import SettingsView from './SettingsView.vue'

const s: PopupStore = usePopupStore()

onMounted(() => s.init())
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
      <button :class="{ active: s.tab === 'scan' }" @click="s.tab = 'scan'">Scan</button>
      <button :class="{ active: s.tab === 'track' }" @click="s.tab = 'track'">Tracked</button>
      <button :class="{ active: s.tab === 'settings' }" @click="s.tab = 'settings'">Settings</button>
    </nav>

    <ScanView v-if="s.tab === 'scan'" :store="s" />
    <TrackView v-else-if="s.tab === 'track'" :store="s" />
    <SettingsView v-else-if="s.tab === 'settings'" :store="s" />

    <div v-if="s.status" class="statusbar" :class="{ error: s.statusError }">{{ s.status }}</div>
  </div>
</template>
