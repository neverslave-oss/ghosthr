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
  // Run one deep-agent turn (message -> reply). The agent lives in main.
  agentTurn: (message) => ipcRenderer.invoke('ghosthr:agent-turn', { message }),
})
