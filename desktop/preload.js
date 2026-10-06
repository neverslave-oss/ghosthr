/**
 * ghostHR desktop — preload.
 *
 * Exposes a minimal, safe bridge to the renderer via contextBridge. The
 * renderer (Agent tab) may ask the main process for the loaded extension id.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ghosthr', {
  getExtensionId: () => ipcRenderer.invoke('ghosthr:get-extension-id'),
})
