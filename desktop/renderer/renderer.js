/**
 * ghostHR desktop — renderer logic (ES module).
 *
 * The desktop is a browser. ghostHR is loaded as a native extension into the
 * same Electron session as the <webview>, and the user interacts with its OWN
 * UI (the extension popup/side panel) — exactly like in a real Chrome window —
 * via a toolbar button that toggles a side panel hosting the extension's real
 * popup page. No bespoke reimplementation of settings/CV/verdict.
 *
 * Layout: Agent tab is split-screen with the BROWSER on the LEFT and the
 * chat on the RIGHT. A single <webview> is shared between the Browser tab and
 * the Agent split-pane (reparented into whichever container is active so there
 * is exactly one live browser page holding the loaded extension).
 */

// ---------- Shared webview ----------
const webview = document.createElement('webview')
webview.id = 'browser-vw'
webview.setAttribute('src', 'https://www.google.com')
webview.setAttribute('allowpopups', 'true')

const browserHost = document.getElementById('tab-browser')
const agentBrowserHost = document.getElementById('agent-browser')

function mountWebview(host) {
  if (!host || webview.parentElement === host) return
  webview.remove()
  host.appendChild(webview)
}

// ---------- Tab switching ----------
const tabButtons = document.querySelectorAll('.tabs button')
const urlBar = document.getElementById('urlbar')

function switchTab(name) {
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  document.getElementById('tab-agent').classList.toggle('active', name === 'agent')
  document.getElementById('tab-browser').classList.toggle('active', name === 'browser')
  urlBar.style.display = name === 'browser' ? 'flex' : 'none'
  if (name === 'browser') mountWebview(browserHost)
  else if (name === 'agent') mountWebview(agentBrowserHost)
}

tabButtons.forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab))
})

// ---------- ghostHR extension side panel ----------
// Hosts the extension's OWN popup page, loaded via the chrome-extension://
// scheme, so the user gets the exact same ghostHR UI/settings/verdict they see
// in a real browser. Requires the extension to be loaded in the shared session
// and its id returned by the main process.
const extPanel = document.getElementById('ext-panel')
const extToggle = document.getElementById('ext-toggle')
const extClose = document.getElementById('ext-close')
let extLoaded = false

async function ensureExtPanel() {
  if (extLoaded) return
  try {
    const id = await window.ghosthr.getExtensionId()
    if (!id) {
      extPanel.innerHTML = '<div class="sp-head"><span>🛠 ghostHR</span><button id="ext-close">✕</button></div>' +
        '<p style="padding:16px;color:var(--ink-dim);font-size:13px">ghostHR extension not loaded. Build the extension first (npm run build at repo root).</p>'
      return
    }
    const extView = document.createElement('webview')
    extView.setAttribute('src', `chrome-extension://${id}/src/popup/index.html`)
    extPanel.appendChild(extView)
    extLoaded = true
  } catch (e) {
    console.error('[ghostHR] ext panel failed:', e)
  }
}

extToggle.addEventListener('click', async () => {
  await ensureExtPanel()
  extPanel.classList.toggle('open')
  extToggle.textContent = extPanel.classList.contains('open') ? '✕ ghostHR' : '🛠 ghostHR'
})
extClose.addEventListener('click', () => {
  extPanel.classList.remove('open')
  extToggle.textContent = '🛠 ghostHR'
})

// ---------- Browser ----------
const urlInput = document.getElementById('url-input')
const goBtn = document.getElementById('go')

function navigate(url) {
  let u = url.trim()
  if (!u) return
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  if (webview && typeof webview.loadURL === 'function') webview.loadURL(u)
  else webview.setAttribute('src', u)
}

goBtn.addEventListener('click', () => navigate(urlInput.value))
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(urlInput.value) })

if (webview) {
  webview.addEventListener('did-navigate', (e) => { urlInput.value = e.url || '' })
  webview.addEventListener('did-navigate-in-page', (e) => { urlInput.value = e.url || '' })
}

// ---------- Scan (feed captured page into the extension content script) ----------
async function captureScan() {
  const image = await webview.capturePage()
  const dataUrl = image.toDataURL()
  await webview.executeJavaScript(
    `document.documentElement.removeAttribute('data-ghosthr-result');` +
      `document.dispatchEvent(new CustomEvent('__ghosthr_scan_image', { detail: { imageDataUrl: ${JSON.stringify(dataUrl)} } })); true`,
  )
  let res = null
  for (let i = 0; i < 60 && !res; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const raw = await webview.executeJavaScript(`document.documentElement.getAttribute('data-ghosthr-result')`)
    if (raw) { try { res = JSON.parse(raw) } catch { /* retry */ } }
  }
  return res
}

const captureBtn = document.getElementById('capture')
if (captureBtn) {
  captureBtn.addEventListener('click', async () => {
    try {
      captureBtn.disabled = true
      captureBtn.textContent = 'Scanning…'
      const res = await captureScan()
      if (res?.ok && res.scan) {
        appendBot(
          `📋 Vision scan complete:\nJob: ${res.scan.jobTitle || '(no title)'}${res.scan.company ? ' — ' + res.scan.company : ''}\nFields detected: ${res.scan.fields?.length ?? 0}`,
        )
      } else {
        appendBot(`⚠️ Vision scan failed: ${res?.error || 'no result'}`)
      }
    } catch (e) {
      console.error('[ghostHR] capture/scan failed:', e)
      appendBot('⚠️ Scan error: ' + (e && e.message))
    } finally {
      captureBtn.disabled = false
      captureBtn.textContent = 'Capture page'
    }
  })
}

// ---------- Agent chat ----------
const chat = document.getElementById('chat')
const agentInput = document.getElementById('agent-input')
const agentSend = document.getElementById('agent-send')

function addMsg(role, text) {
  const div = document.createElement('div')
  div.className = 'msg ' + role
  div.textContent = text
  chat.appendChild(div)
  chat.scrollTop = chat.scrollHeight
  return div
}

function addStreamBubble() {
  const div = document.createElement('div')
  div.className = 'msg bot streaming'
  div.textContent = ''
  chat.appendChild(div)
  chat.scrollTop = chat.scrollHeight
  return {
    node: div,
    set(text) { div.textContent = text; chat.scrollTop = chat.scrollHeight },
  }
}

function appendBot(text) { addMsg('bot', text) }

// Refresh scan/CV/apps/settings via the extension's own context handler so the
// deep agent reads the SAME data the extension stores (shared storage).
async function pullAgentContext() {
  const webviewForCtx = document.querySelectorAll('webview')[0] || webview
  const raw = await webviewForCtx.executeJavaScript(
    `(async () => { try { const r = await chrome.runtime.sendMessage({ type: 'GHOSTHR_AGENT_CONTEXT' }); document.documentElement.setAttribute('data-ghosthr-agent', JSON.stringify(r)); return document.documentElement.getAttribute('data-ghosthr-agent'); } catch(e){ return JSON.stringify({ ok:false, error:String(e&&e.message) }); } })()`,
  )
  try { return JSON.parse(raw) } catch { return { ok: false, error: 'engine context unavailable' } }
}

window.__ghosthrPullAgentContext = () => pullAgentContext().catch((e) => ({ ok: false, error: String(e && e.message) }))

function formatCoaching(ctx) {
  const s = ctx.scan
  const v = ctx.verdict
  const cv = ctx.cv
  if (!s?.jobDescription || !cv) {
    return 'I can only coach once I have both data points:\n\n• Scan a job first — open it in the browser and hit "Capture page"\n• Add your CV in the ghostHR sidebar (🛠)\n\nThen ask me again — e.g. "score my fit".'
  }
  const recLabel = { apply_now: '✅ Apply now', apply_with_caveats: '⚠️ Apply with caveats', hold_back: '🛑 Hold back' }[v.recommendation] || v.recommendation
  let out = `${recLabel} — match ${v.match_score}/100\n`
  out += `Job: ${s.jobTitle || '(untitled)'}${s.company ? ' · ' + s.company : ''}\n\n`
  if (v.score_breakdown) out += `Skills ${v.score_breakdown.skills} · Experience ${v.score_breakdown.experience} · Fit ${v.score_breakdown.fit_signal}\n`
  if (v.gap_analysis?.length) out += `\nGaps:\n• ` + v.gap_analysis.join('\n• ') + '\n'
  if (v.hold_back_actions?.length) {
    out += '\nTo improve your odds:\n'
    for (const a of v.hold_back_actions) out += `• [${a.action}] ${a.detail} (~${a.est_effort_days}d)\n`
  }
  if (v.red_flags?.length) out += `\n⚠️ Red flags: ` + v.red_flags.join(', ') + '\n'
  if (v.reasoning) out += '\n' + v.reasoning
  return out
}

async function runDeepTurn(text, isCoaching) {
  let ctxErr = null
  try { await pullAgentContext() } catch (e) { ctxErr = e }

  const bubble = addStreamBubble()
  bubble.set('…')
  let gotStream = false
  const offChunk = window.ghosthr.onAgentChunk
    ? window.ghosthr.onAgentChunk((p) => { gotStream = true; bubble.set(bubble.node.textContent + (p?.delta || '')) })
    : null
  const offDone = window.ghosthr.onAgentDone
    ? window.ghosthr.onAgentDone(() => { if (!gotStream) bubble.set(''); try { bubble.node.classList.remove('streaming') } catch { /* replaced */ } })
    : null

  try {
    const res = window.ghosthr && await window.ghosthr.agentTurn(text)
    if (res && res.ok) {
      if (!gotStream && isCoaching) { try { bubble.set(formatCoaching(await pullAgentContext())) } catch { bubble.set('⚠️ Could not reach the ghostHR engine.') } }
      return
    }
    if (isCoaching) {
      try { bubble.set(formatCoaching(await pullAgentContext())) } catch { bubble.set('⚠️ Could not reach the ghostHR engine.') }
    } else {
      bubble.set('⚠️ Deep agent unavailable (' + ((res && res.error) || ctxErr || 'no provider configured') + '). Open the ghostHR sidebar (🛠) to add a provider.')
    }
  } catch (e) {
    if (isCoaching) { try { bubble.set(formatCoaching(await pullAgentContext())) } catch { bubble.set('⚠️ Could not reach the ghostHR engine.') } }
    else bubble.set('⚠️ Agent error: ' + (e && e.message))
  } finally {
    if (offChunk) offChunk()
    if (offDone) offDone()
    bubble.node.classList.remove('streaming')
  }
}

async function handleAgent(text) {
  addMsg('user', text)
  const lower = text.toLowerCase()

  if (/(verdict|score|fit|coach|advice|should i apply|would i|could you|recommend|tell me about)/.test(lower)) {
    runDeepTurn(text, true); return
  }
  const urlMatch = text.match(/https?:\/\/[^\s]+/)
  if (urlMatch && /(open|go|browse|visit|look at|load)/.test(lower)) {
    mountWebview(browserHost)
    switchTab('browser')
    navigate(urlMatch[0])
    appendBot(`Opened ${urlMatch[0]} in the browser. Open the ghostHR sidebar (🛠) to scan/autofill.`)
    return
  }
  if (/(help|what can you)/i.test(lower)) {
    appendBot(
      'I\'m ghostHR\'s deep-agent coach.\n\nYou can:\n• "open <job-URL>" — browse the page (extension scans/autofills via the 🛠 sidebar)\n• "score my fit" / "should I apply?" — coaching on the scanned job vs your CV\n• "research <company>" — live web research\n\nProviders + CV live in the ghostHR sidebar (🛠), shared with the browser extension.',
    )
    return
  }
  runDeepTurn(text, false)
}

function send() {
  const text = agentInput.value.trim()
  if (!text) return
  agentInput.value = ''
  handleAgent(text)
}

agentSend.addEventListener('click', send)
agentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })

// ---------- Theme toggle ----------
const themeToggle = document.getElementById('theme-toggle')
const THEME_KEY = 'ghosthr.theme'
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  themeToggle.textContent = t === 'dark' ? '☀️' : '🌙'
  try { localStorage.setItem(THEME_KEY, t) } catch { /* ignore */ }
}
function initTheme() {
  let saved = 'light'
  try { saved = localStorage.getItem(THEME_KEY) || 'light' } catch { /* ignore */ }
  applyTheme(saved)
}
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
    applyTheme(cur === 'dark' ? 'light' : 'dark')
  })
}
initTheme()

// ---------- Boot ----------
mountWebview(agentBrowserHost)

appendBot(
  '👋 Welcome to ghostHR desktop.\n\nThis is a real browser with ghostHR loaded natively — hit the 🛠 button in the toolbar to open the extension (settings, CV, verdict) exactly like a browser side panel. Providers + CV sync with the standalone browser extension.\n\nTry "open https://www.workable.com/jobs/123" or open a job page and hit "Capture page".',
)
