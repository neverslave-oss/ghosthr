/**
 * ghostHR desktop — preload.
 *
 * Exposes a minimal, safe bridge to the renderer via contextBridge. The
 * renderer (Agent tab) asks the main process for the loaded extension id and
 * runs deep-agent turns in the main process (in-process, one installer).
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ghosthr', {
  getExtensionId: () => ipcRenderer.invoke('ghosthr:get-extension-id'),
  // Run one deep-agent turn (message -> reply). The agent lives in main and
  // streams tokens back live via the onAgentChunk/onAgentDone callbacks.
  agentTurn: (message) => ipcRenderer.invoke('ghosthr:agent-turn', { message }),
  // Subscribe to live stream events from the agent (returns an unsubscribe fn).
  onAgentChunk(cb) {
    const l = (_e, p) => cb(p)
    ipcRenderer.on('ghosthr:agent-chunk', l)
    return () => ipcRenderer.removeListener('ghosthr:agent-chunk', l)
  },
  onAgentDone(cb) {
    const l = (_e, p) => cb(p)
    ipcRenderer.on('ghosthr:agent-done', l)
    return () => ipcRenderer.removeListener('ghosthr:agent-done', l)
  },
})
