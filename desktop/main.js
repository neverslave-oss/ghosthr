/**
 * ghostHR desktop — main process.
 *
 * Creates a BrowserWindow with an integrated browser tab (a webview that can
 * navigate any page) and an Agent chat tab. Loads the BUILT ghostHR extension
 * (from ../dist) into the shared session so its content scripts run on the
 * pages opened in the browser tab.
 *
 * The packaged app expects ../dist (the built extension) to be bundled in via
 * electron-builder "files". In dev, run `npm run build` in the repo root first
 * so ../dist exists.
 */
const { app, BrowserWindow, session, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Deep-agent wiring (in-process, one installer, no Python).
const { buildDeepAgent, modelForProvider, pickProvider } = require('./agent/deepAgent')
const { Vfs } = require('./agent/vfs')
const { webSearch } = require('./agent/webSearch')

const DEV = !app.isPackaged
const EXT_DIR = DEV
  ? path.resolve(__dirname, '../dist') // repo-root dist during `npm start`
  : path.join(process.resourcesPath, 'dist')

let mainWindow = null

function resolveDist(p) {
  try {
    return fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

async function loadGhostHrExtension() {
  const dir = resolveDist(EXT_DIR)
  if (!dir) {
    console.warn('[ghostHR] Build not found — run `npm run build` in the repo root first. Skipping extension load.')
    return null
  }
  try {
    // Extension must load into the SAME session the webview uses.
    const ext = await session.defaultSession.loadExtension(dir, { allowFileAccess: true })
    console.log('[ghostHR] Extension loaded:', ext.id)
    return ext
  } catch (e) {
    console.warn('[ghostHR] Extension load failed:', e?.message ?? e)
    return null
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'ghostHR',
    // Same icon as the extension (single-icon identity).
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow <webview> for the integrated browser tab.
      webviewTag: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  await loadGhostHrExtension()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// The Agent tab asks the main process for the current extension id so it can
// address the loaded ghostHR extension if needed.
ipcMain.handle('ghosthr:get-extension-id', () => {
  return null
})

// ---------------------------------------------------------------------------
// Deep agent (in-process). One installer, no Python. The agent lives entirely
// in this main process; the renderer sends a user message over IPC and streams
// back the assembled reply. It reads real ghostHR data (scan/CV/apps/settings)
// through the loaded extension's GHOSTHR_AGENT_CONTEXT handler.
// ---------------------------------------------------------------------------
let deepAgent = null
let agentVfs = null

const agentSettings = () => {
  // Re-fetch settings each turn through the extension data bundle so provider
  // changes are honored live. This cache is refreshed per turn by the renderer
  // (which pulls GHOSTHR_AGENT_CONTEXT and forwards the settings here).
  return agentCurrentSettings || {}
}
let agentCurrentSettings = {}

async function getExtensionContextViaBridge() {
  // Ask the renderer to fetch the latest extension context (scan+CV+apps+
  // settings) through the content-script bridge, then send it back here.
  // Implemented via the renderer's pullAgentContext() exposed to main.
  if (!mainWindow) return null
  const ctx = await mainWindow.webContents.executeJavaScript(
    `(async () => { try { return await window.__ghosthrPullAgentContext(); } catch(e) { return { ok:false, error:String(e&&e.message) }; } })()`,
  )
  return ctx
}

// Cache latest context so the agent tools can read it during a turn.
let agentContextCache = null

ipcMain.handle('ghosthr:agent-turn', async (_evt, payload) => {
  const message = String(payload?.message || '').trim()
  if (!message) return { ok: false, error: 'empty message' }

  try {
    // 1. Ensure the VFS exists (persisted under userData).
    if (!agentVfs) {
      agentVfs = new Vfs(path.join(app.getPath('userData'), 'ghosthr-vfs'))
    }

    // 2. Refresh context (scan/CV/apps/settings) from the extension bridge.
    const ctx = await getExtensionContextViaBridge()
    agentContextCache = ctx && ctx.ok
      ? { scan: ctx.scan, cv: ctx.cv, verdict: ctx.verdict, applications: ctx.applications, settings: ctx.settings }
      : agentContextCache
    if (ctx?.settings) agentCurrentSettings = ctx.settings

    // 3. Build the deep agent lazily (once per settings/model change).
    if (!deepAgent) {
      deepAgent = await buildDeepAgent({
        getAgentContext: async () => ({
          scan: agentContextCache?.scan || null,
          cv: agentContextCache?.cv || null,
          verdict: agentContextCache?.verdict || null,
        }),
        getApplications: async () => agentContextCache?.applications || [],
        getSettings: async () => agentCurrentSettings,
        vfs: agentVfs,
        webSearch: webSearch,
        resolveModel: (settings) => {
          const p = pickProvider(settings)
          return p ? modelForProvider(p) : null
        },
      })
    }

    // 4. Run the agent turn, streaming assistant tokens live to the renderer.
    // streamMode 'messages' yields [messageChunk, metadata] tuples with
    // per-token deltas; 'values' gives the full latest state (used as a
    // robust fallback if a provider/agent doesn't emit message chunks).
    const sender = _evt.sender
    const emit = (delta) => {
      try { sender.send('ghosthr:agent-chunk', { delta }) } catch { /* window closed */ }
    }
    const final = await deepAgent.agent.stream(
      { messages: [{ role: 'user', content: message }] },
      { streamMode: ['values', 'messages'] },
    )
    let lastText = ''
    for await (const chunk of final) {
      // 'messages' mode: [messageChunk, metadata]
      if (Array.isArray(chunk) && chunk[0]) {
        const meta = chunk[1] || {}
        if (meta.langgraph_node === 'agent') {
          const d = chunk[0].content
          if (typeof d === 'string' && d) emit(d)
        }
        continue
      }
      // 'values' fallback: diff the latest assistant message content.
      const msgs = chunk?.values?.messages
      if (!Array.isArray(msgs) || !msgs.length) continue
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant' && typeof last.content === 'string') {
        const delta = lastText.length ? last.content.slice(lastText.length) : last.content
        lastText = last.content
        if (delta) emit(delta)
      }
    }
    // Signal completion so the renderer finalizes the streaming bubble.
    try {
      sender.send('ghosthr:agent-done', {
        ok: true,
        model: deepAgent.modelUsed?.modelName || '',
        tools: deepAgent.tools,
      })
    } catch { /* window closed */ }

    return { ok: true, model: deepAgent.modelUsed?.modelName || '', tools: deepAgent.tools }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
})
