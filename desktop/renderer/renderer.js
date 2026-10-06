/**
 * ghostHR desktop — renderer logic (ES module).
 *
 * Drives a tab switcher (Agent | Browser | Settings), an integrated <webview>
 * browser with the ghostHR extension content scripts active, an Agent chat
 * that runs the in-process deep agent, and a native Settings panel that reads
 * and writes the SAME chrome.storage.local as the standalone browser extension
 * (via the content-script bridge).
 *
 * A single <webview> is shared between the Browser tab and the Agent tab's
 * split-pane: it is reparented into whichever container is active so there's
 * exactly one live browser page (and therefore one session holding the loaded
 * extension).
 */

import { bridgeCall, getSettings, saveSettings, getAgentContext } from './ghostBridge.js'
import { init as initSettings } from './settings.js'

// ---------- Shared webview ----------
const webview = document.createElement('webview')
webview.id = 'browser-vw'
webview.setAttribute('src', 'https://www.google.com')
webview.setAttribute('allowpopups', 'true')

const browserHost = document.getElementById('tab-browser')
const agentBrowserHost = document.getElementById('agent-browser')

// Keep the webview in whichever container is active.
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
  document.getElementById('tab-settings').classList.toggle('active', name === 'settings')
  // Only the Browser tab needs the URL bar.
  urlBar.style.display = name === 'browser' ? 'flex' : 'none'
  if (name === 'browser') mountWebview(browserHost)
  else if (name === 'agent') mountWebview(agentBrowserHost)
}

tabButtons.forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab))
})

// ---------- Browser ----------
const urlInput = document.getElementById('url-input')
const goBtn = document.getElementById('go')

function navigate(url) {
  let u = url.trim()
  if (!u) return
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  if (webview && typeof webview.loadURL === 'function') {
    webview.loadURL(u)
  } else {
    webview.setAttribute('src', u)
  }
}

goBtn.addEventListener('click', () => navigate(urlInput.value))
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate(urlInput.value)
})

// Keep the URL bar in sync as the user browses.
if (webview) {
  webview.addEventListener('did-navigate', (e) => { urlInput.value = e.url || '' })
  webview.addEventListener('did-navigate-in-page', (e) => { urlInput.value = e.url || '' })
}

// ---------- Scan + agent context via the extension bridge ----------
// Screen capture at the ELECTRON layer: chrome.tabs.captureVisibleTab is not
// implemented, but <webview>.capturePage() returns a PNG which we feed into the
// SAME vision pipeline via the content-script bridge.
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
        const s = res.scan
        appendBot(
          `📋 Vision scan complete (${res.offline ? 'offline' : 'AI'}):\n` +
            `Job: ${s.jobTitle || '(no title)'}${s.company ? ' — ' + s.company : ''}\n` +
            `Fields detected: ${s.fields?.length ?? 0}`,
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

// Refresh scan/CV/apps/settings via the extension's own context handler, so the
// deep agent reads the SAME data the extension stores (shared with the browser).
async function pullAgentContext() {
  const ctx = await getAgentContext()
  if (!ctx || ctx.ok === false) throw new Error((ctx && ctx.error) || 'engine context unavailable')
  return ctx
}

window.__ghosthrPullAgentContext = () => pullAgentContext().catch((e) => ({ ok: false, error: String(e && e.message) }))

function formatCoaching(ctx) {
  const s = ctx.scan
  const v = ctx.verdict
  const cv = ctx.cv
  if (!s?.jobDescription || !cv) {
    return 'I can only coach once I have both data points:\n\n• Scan a job first — go to Browser, open a job page, hit "Capture page".\n• Upload your CV in Settings.\n\nThen ask me again — e.g. "score my fit" or "should I apply?".'
  }
  const recLabel = { apply_now: '✅ Apply now', apply_with_caveats: '⚠️ Apply with caveats', hold_back: '🛑 Hold back' }[v.recommendation] || v.recommendation
  let out = `${recLabel} — match ${v.match_score}/100\n`
  out += `Job: ${s.jobTitle || '(untitled)'}${s.company ? ' · ' + s.company : ''}\n\n`
  if (v.score_breakdown) {
    out += `Skills ${v.score_breakdown.skills} · Experience ${v.score_breakdown.experience} · Fit ${v.score_breakdown.fit_signal}\n`
  }
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
  const offChunk = (window.ghosthr && window.ghosthr.onAgentChunk)
    ? window.ghosthr.onAgentChunk((p) => { gotStream = true; bubble.set(bubble.node.textContent + (p?.delta || '')) })
    : null
  const offDone = (window.ghosthr && window.ghosthr.onAgentDone)
    ? window.ghosthr.onAgentDone(() => { try { if (!gotStream) bubble.set(''); bubble.node.classList.remove('streaming') } catch { /* replaced */ } })
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
      bubble.set('⚠️ Deep agent unavailable (' + ((res && res.error) || ctxErr || 'no provider configured') + '). Open Settings to add a provider.')
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
    appendBot(`Opened ${urlMatch[0]} in the Browser tab — the ghostHR extension runs there. Use the extension to scan and autofill.`)
    return
  }
  if (/(help|what can you)/i.test(lower)) {
    appendBot(
      'I\'m ghostHR\'s deep-agent coach.\n\nYou can:\n• "open <job-URL>" — navigate the browser (extension scans/autofills)\n• "score my fit" / "should I apply?" — coaching on the scanned job vs your CV\n• "research <company>" — live web research\n• Edit providers / upload your CV in the Settings tab.\n\nI read the current scan, CV and applications and use a private workspace for files.',
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
const THEME_KEY = 'ghosthr.desktop.theme'
function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light'
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
// Mount the webview into the agent split-pane (the default active tab).
mountWebview(agentBrowserHost)
initSettings()

appendBot(
  '👋 Welcome to ghostHR desktop.\n\nI\'m here with the ghostHR extension built in — browse any job site and the extension scans + autofills. Configure providers and upload your CV in the Settings tab; settings are shared with the browser extension.\n\nTry "open https://www.workable.com/jobs/123" or "score my fit".',
)
