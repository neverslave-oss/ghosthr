/**
 * ghostHR desktop — renderer logic.
 *
 * Drives the tab switcher (Agent | Browser), the integrated <webview> browser
 * (navigating any URL, with the ghostHR extension content scripts active), and
 * a lightweight Agent chat tab.
 *
 * The Agent tab is intentionally first. It's a chat surface for ghostHR — the
 * backend/agent wiring is the next phase; for now it holds the conversation
 * and can open job URLs in the browser tab on request.
 */

// ---------- Tab switching ----------
const tabButtons = document.querySelectorAll('.tabs button')
const urlBar = document.getElementById('urlbar')

function switchTab(name) {
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  document.getElementById('tab-agent').classList.toggle('active', name === 'agent')
  document.getElementById('tab-browser').classList.toggle('active', name === 'browser')
  // Only the Browser tab needs the URL bar.
  urlBar.style.display = name === 'browser' ? 'flex' : 'none'
}

tabButtons.forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab))
})

// ---------- Browser tab ----------
const webview = document.getElementById('browser-vw')
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

// Screen capture at the ELECTRON layer — fully supported.
// The extension's own vision-scan uses chrome.tabs.captureVisibleTab, which
// Electron does NOT implement; but <webview>.capturePage() works and returns
// the page as a PNG, so desktop capture never needs the extension API.
//
// The captured PNG is fed into the SAME vision pipeline as a browser scan:
// we run JS inside the webview to dispatch __ghosthr_scan_image with the image;
// the extension's content script (isolated world) relays it to the background
// GHOSTHR_SCAN_IMAGE handler via chrome.runtime, then writes the scan result
// onto <html data-ghosthr-result>. We poll that attribute back out.
const captureBtn = document.getElementById('capture')
if (captureBtn && webview) {
  captureBtn.addEventListener('click', async () => {
    try {
      captureBtn.disabled = true
      captureBtn.textContent = 'Scanning…'
      const image = await webview.capturePage()
      const dataUrl = image.toDataURL()

      // Clear any prior result, then dispatch the image into the webview page.
      await webview.executeJavaScript(
        `document.documentElement.removeAttribute('data-ghosthr-result');` +
          `document.dispatchEvent(new CustomEvent('__ghosthr_scan_image', { detail: { imageDataUrl: ${JSON.stringify(dataUrl)} } })); true`,
      )

      // Poll the result attribute the content script writes back.
      let res = null
      for (let i = 0; i < 60 && !res; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const raw = await webview.executeJavaScript(
          `document.documentElement.getAttribute('data-ghosthr-result')`,
        )
        if (raw) {
          try { res = JSON.parse(raw) } catch { res = null }
        }
      }

      if (res?.ok && res.scan) {
        const s = res.scan
        appendBot(
          `📋 Vision scan complete (${res.offline ? 'offline' : 'AI'}):\n` +
            `Job: ${s.jobTitle || '(no title)'}${s.company ? ' — ' + s.company : ''}\n` +
            `Fields detected: ${s.fields?.length ?? 0}\n` +
            (s.jobDescription
              ? `Description: ${s.jobDescription.slice(0, 200)}${s.jobDescription.length > 200 ? '…' : ''}`
              : ''),
        )
      } else {
        appendBot('⚠️ Vision scan failed: ' + (res?.error || 'no result'))
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

// Keep the URL bar in sync as the user browses.
if (webview) {
  webview.addEventListener('did-navigate', (e) => {
    urlInput.value = e.url || ''
  })
  webview.addEventListener('did-navigate-in-page', (e) => {
    urlInput.value = e.url || ''
  })
}

// Auto-open the URL bar in the browser tab? The webview is the focus there.
switchTab('agent') // Agent tab is the default/first tab

// ---------- Agent chat ----------
const chat = document.getElementById('chat')
const agentInput = document.getElementById('agent-input')
const agentSend = document.getElementById('agent-send')

// Pull scan + CV + verdict through the extension bridge. Reuses the real
// in-process TS engine (GHOSTHR_AGENT_CONTEXT -> verdict.analyze), so the Agent
// tab coaches from the SAME engine as the popup's "Score my fit".
async function pullAgentContext() {
  if (!webview) throw new Error('No browser available')
  await webview.executeJavaScript(
    `document.documentElement.removeAttribute('data-ghosthr-agent');` +
      `document.dispatchEvent(new CustomEvent('__ghosthr_agent_context')); true`,
  )
  let res = null
  for (let i = 0; i < 30 && !res; i++) {
    await new Promise((r) => setTimeout(r, 400))
    const raw = await webview.executeJavaScript(
      `document.documentElement.getAttribute('data-ghosthr-agent')`,
    )
    if (raw) {
      try { res = JSON.parse(raw) } catch { res = null }
    }
  }
  if (!res) throw new Error('ghostHR engine did not respond')
  if (!res.ok) throw new Error(res.error || 'engine error')
  return res
}

// Expose the context puller to the main process (invoked via
// webContents.executeJavaScript) so the deep agent can read real scan/CV/apps/
// settings each turn.
window.__ghosthrPullAgentContext = () => pullAgentContext()

// Render the verdict into a short coaching reply.
function formatCoaching(ctx) {
  const s = ctx.scan
  const v = ctx.verdict
  const cv = ctx.cv
  if (!s?.jobDescription || !cv) {
    return 'I can only coach once I have both data points:\n\n• Scan a job first — go to the Browser tab, open a job page, and hit "Capture page" (or use the extension).\n• Upload your CV (Settings / scan in the extension).\n\nThen ask me again — e.g. "score my fit" or "should I apply?".'
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
    for (const a of v.hold_back_actions) {
      out += `• [${a.action}] ${a.detail} (~${a.est_effort_days}d)\n`
    }
  }
  if (v.red_flags?.length) out += `\n⚠️ Red flags: ` + v.red_flags.join(', ') + '\n'
  if (v.reasoning) out += '\n' + v.reasoning
  return out
}

function addMsg(role, text) {
  const div = document.createElement('div')
  div.className = 'msg ' + role
  div.textContent = text
  chat.appendChild(div)
  chat.scrollTop = chat.scrollHeight
  return div
}

// Create an empty bot bubble for live streamed text. Returns {node, set} where
// set(text) replaces the content (preserving whitespace/multiline).
function addStreamBubble() {
  const div = document.createElement('div')
  div.className = 'msg bot streaming'
  div.textContent = ''
  chat.appendChild(div)
  chat.scrollTop = chat.scrollHeight
  return {
    node: div,
    set(text) {
      div.textContent = text
      chat.scrollTop = chat.scrollHeight
    },
  }
}

function appendBot(text) {
  addMsg('bot', text)
}

// Run one deep-agent turn (in-process, main process). Uses the real LangGraph
// agent with coach tools + VFS + web research. Falls back to the deterministic
// analyze() coaching if the deep agent can't run (no configured provider / error).
async function runDeepTurn(text, isCoaching) {
  // The deep agent needs the scan/CV/apps/settings context refreshed first so
  // main can read it on this turn.
  let ctxErr = null
  try {
    await pullAgentContext()
  } catch (e) { ctxErr = e }

  const bubble = addStreamBubble()
  bubble.set('…')
  let gotStream = false
  const offChunk = (window.ghosthr && window.ghosthr.onAgentChunk)
    ? window.ghosthr.onAgentChunk((p) => { gotStream = true; bubble.set(bubble.node.textContent + (p?.delta || '')) })
    : null
  const offDone = (window.ghosthr && window.ghosthr.onAgentDone)
    ? window.ghosthr.onAgentDone((p) => {
        try {
          if (!gotStream) bubble.set('')
          bubble.node.classList.remove('streaming')
        } catch { /* bubble already replaced */ }
      })
    : null

  try {
    const res = window.ghosthr && await window.ghosthr.agentTurn(text)
    if (res && res.ok) {
      // Done event (or stream) finalized the bubble. If nothing streamed
      // (agent didn't emit chunks), fall back to offline coaching.
      if (!gotStream && isCoaching) {
        try { bubble.set(formatCoaching(await pullAgentContext())) } catch { bubble.set('⚠️ Could not reach the ghostHR engine.') }
      }
      return
    }
    // Not ok: fall back.
    if (isCoaching) {
      try { bubble.set(formatCoaching(await pullAgentContext())) } catch { bubble.set('⚠️ Could not reach the ghostHR engine.') }
    } else {
      const err = (res && res.error) || 'no reply from agent'
      bubble.set('⚠️ Deep agent unavailable (' + err + '). Try "score my fit" for offline coaching.')
    }
  } catch (e) {
    if (isCoaching) {
      try { bubble.set(formatCoaching(await pullAgentContext())) } catch { bubble.set('⚠️ Could not reach the ghostHR engine.') }
    } else {
      bubble.set('⚠️ Agent error: ' + (e && e.message))
    }
  } finally {
    if (offChunk) offChunk()
    if (offDone) offDone()
    bubble.node.classList.remove('streaming')
  }
}

function handleAgent(text) {
  addMsg('user', text)
  const lower = text.toLowerCase()

  // Coaching: run the deep agent (in-process). It reads scan/CV/apps/settings
  // via the extension bridge and uses tools (coach, VFS, web research). Falls
  // back to the deterministic analyze() coaching if the deep agent can't run
  // (e.g. no configured provider).
  if (/(verdict|score|fit|coach|advice|should i apply|would i|could you|recommend|tell me about)/.test(lower)) {
    runDeepTurn(text, true)
    return
  }

  // Open a URL in the browser tab when the user gives one.
  const urlMatch = text.match(/https?:\/\/[^\s]+/)
  if (urlMatch && /(open|go|browse|visit|look at|load)/.test(lower)) {
    navigate(urlMatch[0])
    appendBot(`Opened ${urlMatch[0]} in the Browser tab. The ghostHR extension runs there — use the extension to scan and autofill.`)
    return
  }

  if (/(help|what can you)/i.test(lower)) {
    appendBot(
      'I\'m ghostHR\'s deep-agent coach.\n\nYou can:\n• "open <job-URL>" — navigate the Browser tab (extension scans/autofills there)\n• "score my fit" / "should I apply?" — deep-agent coaching on the scanned job vs your CV\n• "research <company>" — live web research to ground the advice\n\nI read your current scan, CV, and applications, use a private virtual workspace for files, and can search the web.'
    )
    return
  }

  // Everything else: run the deep agent (non-coaching context).
  runDeepTurn(text, false)
}

function send() {
  const text = agentInput.value.trim()
  if (!text) return
  agentInput.value = ''
  handleAgent(text)
}

agentSend.addEventListener('click', send)
agentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send()
})

// A little welcome so the Agent tab isn't empty on first run.
appendBot(
  '👋 Welcome to ghostHR desktop.\n\nI\'ll live here as your ghostHR agent. For now I can open job pages in the Browser tab — the extension does the scanning + autofill there.\n\nTry: "open https://www.workable.com/jobs/123" or type "help".',
)
