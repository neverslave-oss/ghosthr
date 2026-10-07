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
const { app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

// Loopback port for the extension's Agent tab to reach this desktop agent when
// ghostHR is loaded inside the desktop (browser-extension wire). Standalone
// browser usage falls back to the extension's own provider chat instead.
const AGENT_PORT = 18977

// Deep-agent wiring (in-process, one installer, no Python).
const { buildDeepAgent, modelForProvider, pickProvider } = require('./agent/deepAgent')
const { Vfs } = require('./agent/vfs')
const { webSearch } = require('./agent/webSearch')

const DEV = !app.isPackaged
const EXT_DIR = DEV
  ? path.resolve(__dirname, '../dist') // repo-root dist during `npm start`
  : path.join(process.resourcesPath, 'dist')

let mainWindow = null
let loadedExtId = null
let tray = null
let isQuitting = false

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
    loadedExtId = ext.id
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

  // Close (X) hides to the system tray instead of quitting, so the app stays
  // resident and one tray click brings it back. True quit only happens via the
  // tray menu / app.quit(), which sets isQuitting.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'build', 'icon.png'))
    .resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('ghostHR')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ghostHR', click: () => { showMainWindow() } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
  ]))
  // Clicking the tray icon opens the app.
  tray.on('click', () => showMainWindow())
}

function showMainWindow() {
  if (!mainWindow) { createWindow(); return }
  mainWindow.show()
  mainWindow.focus()
}

app.on('before-quit', () => { isQuitting = true })

app.on('window-all-closed', () => {
  // Keep running in the tray — do NOT quit when the window is closed.
})

// The Agent tab asks the main process for the current extension id so it can
// address the loaded ghostHR extension if needed.
ipcMain.handle('ghosthr:get-extension-id', () => {
  return loadedExtId
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

/**
 * Run one deep-agent turn with the shared ghostHR context and return the full
 * assembled reply. `emit` is an optional per-token callback (used by the
 * desktop renderer for streaming); the extension's loopback HTTP bridge calls
 * it with no emitter and just reads back the final text.
 */
async function runAgentTurn(message, emit) {
  const onDelta = typeof emit === 'function' ? emit : () => {}
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

    // 4. Run the agent turn, streaming assistant tokens via onDelta.
    // streamMode 'messages' yields [messageChunk, metadata] tuples with
    // per-token deltas; 'values' gives the full latest state (used as a
    // robust fallback if a provider/agent doesn't emit message chunks).
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
          if (typeof d === 'string' && d) onDelta(d)
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
        if (delta) onDelta(delta)
      }
    }
    return {
      ok: true,
      text: lastText,
      model: deepAgent.modelUsed?.modelName || '',
      tools: deepAgent.tools,
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

ipcMain.handle('ghosthr:agent-turn', async (_evt, payload) => {
  const message = String(payload?.message || '').trim()
  if (!message) return { ok: false, error: 'empty message' }
  const sender = _evt.sender
  const emit = (delta) => {
    try { sender.send('ghosthr:agent-chunk', { delta }) } catch { /* window closed */ }
  }
  const res = await runAgentTurn(message, emit)
  try {
    sender.send('ghosthr:agent-done', {
      ok: res.ok,
      model: res?.model || '',
      tools: res?.tools || [],
    })
  } catch { /* window closed */ }
  return res
})

// ---------------------------------------------------------------------------
// Loopback agent bridge — lets the extension's Agent tab (when loaded inside
// this desktop app) call the same deep agent. If this desktop isn't running,
// the extension falls back to its standalone provider chat.
//   GET  /agent/health -> { ok:true }
//   POST /agent        -> { message } -> { ok, text, model, tools | error }
// ---------------------------------------------------------------------------
function startAgentBridge() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'chrome-extension://*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (req.method === 'GET' && req.url === '/agent/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'POST' && req.url === '/agent') {
      let body = ''
      for await (const c of req) body += c
      let message = ''
      try { message = String(JSON.parse(body)?.message || '').trim() } catch { /* fallthrough */ }
      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'empty message' }))
        return
      }
      const result = await runAgentTurn(message)
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
  })
  server.listen(AGENT_PORT, '127.0.0.1', () => {
    console.log(`[ghostHR] Agent bridge on http://127.0.0.1:${AGENT_PORT}`)
  })
  server.on('error', (e) => {
    console.warn('[ghostHR] Agent bridge unavailable:', e?.message ?? e)
  })
  return server
}

app.whenReady().then(async () => {
  await loadGhostHrExtension()
  createWindow()
  createTray()
  startAgentBridge()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})
