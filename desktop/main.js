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
