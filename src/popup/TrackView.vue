<script setup lang="ts">
import type { PopupStore } from './store'

const props = defineProps<{ store: PopupStore }>()
const s = props.store
</script>

<template>
  <main>
    <div v-if="!s.applications.length" class="empty">No applications tracked yet.<br />Scan a job, apply, then hit "track it".</div>
    <ul v-else class="track-list">
      <li v-for="a in s.applications" :key="a.id">
        <div class="co">{{ a.company }}</div>
        <div class="role">{{ a.role }}</div>
        <div class="meta">
          <span class="stage-pill">{{ a.stage }}</span>
          <span>{{ new Date(a.applied_at).toLocaleDateString() }}</span>
        </div>
      </li>
    </ul>
  </main>
</template>
