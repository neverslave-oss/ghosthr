/**
 * ghostHR desktop — renderer logic (ES module).
 *
 * The desktop is a browser. ghostHR is loaded as a native extension into the
 * same Electron default session as the main process's WebContentsView browser
 * (replacing the legacy <webview>), and the user interacts with its OWN UI (the
 * extension popup/side panel) exactly like in a real Chrome window. The browser
 * page itself is drawn by a main-process native WebContentsView; this renderer
 * is just the chrome (header, urlbar, tabs, theme toggle, chat) that positions
 * that view via window.browserApi.setBounds(...) and drives it via IPC.
 *
 * Layout: Agent tab is split-screen — the browser on the LEFT, chat on the
 * RIGHT. Browser tab shows the browser filling the whole area. Only one region
 * is visible at a time; the renderer measures whichever browser container is
 * active (ResizeObserver + tab switch) and reports its pixel bounds to main.
 */

// ---------- Tab switching ----------
const tabButtons = document.querySelectorAll('.tabs button')
const urlBar = document.getElementById('urlbar')
const browserHost = document.getElementById('tab-browser')
const agentBrowserHost = document.getElementById('agent-browser')
let currentTab = 'agent'

function switchTab(name) {
  currentTab = name
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  document.getElementById('tab-agent').classList.toggle('active', name === 'agent')
  document.getElementById('tab-browser').classList.toggle('active', name === 'browser')
  // The browser toolbar (url bar + pinned ghostHR action + capture) stays as
  // the desktop's browser chrome so the extension stays reachable either way.
  requestAnimationFrame(reportBounds)
}

tabButtons.forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab))
})

// ---------- Browser bounds (position the native WebContentsView) ----------
function browserHostFor(tab) {
  return tab === 'browser' ? browserHost : agentBrowserHost
}

// Measure the active browser container and tell main where to put the view.
function reportBounds() {
  const host = browserHostFor(currentTab)
  if (!host || !window.browserApi) return
  const r = host.getBoundingClientRect()
  if (!r.width || !r.height) return // hidden container -> nothing to report
  window.browserApi.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
}

// Keep the view glued to its container across resizes and relayouts.
const ro = new ResizeObserver(() => reportBounds())
for (const host of [browserHost, agentBrowserHost]) {
  if (host) ro.observe(host)
}
window.addEventListener('resize', reportBounds)

// ---------- Browser ----------
const urlInput = document.getElementById('url-input')
const goBtn = document.getElementById('go')

// The Browser view loads ghostHR natively via the shared default session: its
// content script renders ghostHR's own in-page UI (floating action + side panel)
// inside the view, exactly like the standalone add-on in a real browser. So the
// desktop shell has no ghostHR-specific chrome of its own — the URL bar,
// navigation and Capture are the only browser chrome.

function navigate(url) {
  if (!window.browserApi) return
  window.browserApi.navigate(url)
}

goBtn.addEventListener('click', () => navigate(urlInput.value))
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(urlInput.value) })

if (window.browserApi) {
  window.browserApi.onNavigate(({ url } = {}) => {
    if (url) urlInput.value = url
  })
}

// ---------- Scan (feed captured page into the extension content script) ----------
async function captureScan() {
  const cap = await window.browserApi.capturePage()
  if (!cap || !cap.ok) throw new Error((cap && cap.error) || 'capture failed')
  const res = await window.browserApi.scanImage(cap.dataUrl)
  return res || { ok: false, error: 'no scan result' }
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
// deep agent reads the SAME data the extension stores (shared storage). Main
// dispatches into the embedded browser's page and returns the parsed bundle.
async function pullAgentContext() {
  const res = await window.browserApi.getAgentContext()
  return res || { ok: false, error: 'engine context unavailable' }
}

window.__ghosthrPullAgentContext = () => pullAgentContext().catch((e) => ({ ok: false, error: String(e && e.message) }))

function formatCoaching(ctx) {
  const s = ctx.scan
  const v = ctx.verdict
  const cv = ctx.cv
  if (!s?.jobDescription || !cv) {
    return 'I can only coach once I have both data points:\n\n• Scan a job first — open it in the browser and hit "Capture page"\n• Add your CV via the ghostHR launcher on the page (the HR button)\n\nThen ask me again — e.g. "score my fit".'
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
      bubble.set('⚠️ Deep agent unavailable (' + ((res && res.error) || ctxErr || 'no provider configured') + '). Open the ghostHR launcher on the page (HR button) to add a provider.')
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
    switchTab('browser')
    navigate(urlMatch[0])
    appendBot(`Opened ${urlMatch[0]} in the browser. Use the ghostHR launcher on the page (HR button) to scan/autofill.`)
    return
  }
  if (/(help|what can you)/i.test(lower)) {
    appendBot(
      'I\'m ghostHR\'s deep-agent coach.\n\nYou can:\n• "open <job-URL>" — browse the page (extension scans/autofills via its on-page launcher)\n• "score my fit" / "should I apply?" — coaching on the scanned job vs your CV\n• "research <company>" — live web research\n\nProviders + CV live in the ghostHR launcher (HR button) on the page, shared with the browser extension.',
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
requestAnimationFrame(reportBounds)

appendBot(
  '👋 Welcome to ghostHR desktop.\n\nThis is a real browser with ghostHR loaded natively into the page — use the ghostHR launcher (HR button) that appears on pages to open the extension (settings, CV, verdict) exactly like a standalone add-on. Providers + CV sync with the standalone browser extension.\n\nTry "open https://www.workable.com/jobs/123" or open a job page and hit "Capture page".',
)
