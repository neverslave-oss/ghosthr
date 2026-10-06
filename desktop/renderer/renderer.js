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

function addMsg(role, text) {
  const div = document.createElement('div')
  div.className = 'msg ' + role
  div.textContent = text
  chat.appendChild(div)
  chat.scrollTop = chat.scrollHeight
}

function appendBot(text) {
  addMsg('bot', text)
}

function handleAgent(text) {
  addMsg('user', text)
  const lower = text.toLowerCase()

  // Open a URL in the browser tab when the user gives one.
  const urlMatch = text.match(/https?:\/\/[^\s]+/)
  if (urlMatch && /(open|go|browse|visit|look at|load)/.test(lower)) {
    navigate(urlMatch[0])
    appendBot(`Opened ${urlMatch[0]} in the Browser tab. The ghostHR extension runs there — use the extension to scan and autofill.`)
    return
  }

  if (/(help|what can you)/i.test(lower)) {
    appendBot(
      'I\'m ghostHR\'s Agent tab.\n\nYou can:\n• "open <job-URL>" to navigate the Browser tab\n• Paste a job URL and I\'ll open it\n\nNext phase: the agent will read the scanned job + your CV and give hold-back coaching advice here. For now, scan the page in the Browser tab using the ghostHR extension.',
    )
    return
  }

  appendBot(
    'I can open job pages in the Browser tab (the ghostHR extension runs there to scan + autofill).\n\nTry: "open https://example.com/jobs/senior-engineer"\n\nDeeper agent capabilities (reading your scan + CV for coaching advice) are the next phase.',
  )
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
