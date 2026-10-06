<script setup lang="ts">
import { ref } from 'vue'
import type { PopupStore } from './store'

const props = defineProps<{ store: PopupStore }>()
const s = props.store
const input = ref('')

function send() {
  const text = input.value.trim()
  if (!text || s.agentBusy) return
  input.value = ''
  s.sendAgent(text)
}
</script>

<template>
  <main class="agent-view">
    <div v-if="!s.agentMessages.length" class="empty agent-empty">
      Ask ghostHR about a job, your fit, or an application.<br />
      <span class="hint">Uses the desktop deep agent when the desktop is open, otherwise your AI providers.</span>
    </div>

    <div v-else class="agent-chat" ref="chatEl">
      <div v-for="(m, i) in s.agentMessages" :key="i" class="msg" :class="m.role">
        <span v-if="m.role === 'assistant'">{{ m.text }}</span>
        <span v-else>{{ m.text }}</span>
      </div>
    </div>

    <div class="agent-mode" v-if="s.agentMode">
      <span class="mode-pill" :class="s.agentMode">
        {{ s.agentMode === 'desktop' ? '⚡ Desktop agent' : '🌐 Standalone providers' }}
      </span>
    </div>

    <div class="agent-composer">
      <input
        v-model="input"
        placeholder="Ask about a job or your fit…"
        :disabled="s.agentBusy"
        @keydown.enter="send"
      />
      <button :disabled="s.agentBusy || !input.trim()" @click="send">
        {{ s.agentBusy ? '…' : 'Send' }}
      </button>
    </div>
  </main>
</template>
