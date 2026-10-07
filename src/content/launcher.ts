/**
 * ghostHR in-page launcher.
 *
 * Renders ghostHR's OWN UI into the page — a floating action button plus a
 * side panel that loads the extension's real popup — so the extension behaves
 * like a standalone installed add-on acting on the page. This works identically
 * in a normal browser and inside the desktop's browser view (the shared-session
 * webview), because it is driven by the extension's content script, not by any
 * desktop-app shell chrome.
 *
 * Uses a shadow root + fixed positioning so it is visually and stylistically
 * isolated from the host page. Kept light; the heavy logic lives in the popup
 * it hosts.
 */

const HOST_ID = 'ghosthr-launcher-root'

export function mountLauncher(): void {
  // Desktop only. In a normal standalone browser the extension is already
  // reachable via its native toolbar action -> popup; there a floating in-
  // page button would be redundant and intrusive. In the desktop's browser
  // view, Electron gives us no native chrome.action/sidePanel toolbar icon,
  // so the extension renders its own in-page UI (this launcher) to behave
  // like the standalone add-on acting on the page.
  if (!/Electron\//i.test(navigator.userAgent)) return
  if (document.getElementById(HOST_ID)) return

  const host = document.createElement('div')
  host.id = HOST_ID
  const shadow = host.attachShadow({ mode: 'open' })
  document.documentElement.appendChild(host)

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    .gh-fab {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      width: 44px; height: 44px; border-radius: 12px; border: none; cursor: pointer;
      background: linear-gradient(135deg, #8b5cf6, #06b6d4); color: #fff;
      display: grid; place-items: center; font-weight: 800; font-size: 18px;
      box-shadow: 0 4px 18px rgba(0,0,0,.35);
    }
    .gh-fab:hover { filter: brightness(1.06); }
    .gh-panel {
      position: fixed; top: 10px; right: 10px; bottom: 10px; z-index: 2147483646;
      width: 400px; max-width: 88vw; border-radius: 12px; overflow: hidden;
      background: #fff; border: 1px solid #e5e7eb;
      box-shadow: 0 10px 40px rgba(0,0,0,.35);
      display: none; flex-direction: column;
    }
    .gh-panel.open { display: flex; }
    .gh-panel iframe { flex: 1; width: 100%; border: 0; background: #fff; }
    .gh-panel .gh-head {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      border-bottom: 1px solid #e5e7eb; font-weight: 700; font-size: 13px;
    }
    .gh-panel .gh-close { margin-left: auto; border: 0; background: transparent; cursor: pointer; font-size: 14px; color: #666; }
  `
  shadow.appendChild(style)

  // Floating action button (ghostHR mark).
  const fab = document.createElement('button')
  fab.className = 'gh-fab'
  fab.title = 'ghostHR'
  fab.textContent = 'HR'

  // Side panel hosting the extension's real popup.
  const panel = document.createElement('div')
  panel.className = 'gh-panel'
  const head = document.createElement('div')
  head.className = 'gh-head'
  head.innerHTML = '<span>ghostHR</span>'
  const close = document.createElement('button')
  close.className = 'gh-close'
  close.textContent = '✕'
  head.appendChild(close)
  const frame = document.createElement('iframe')
  frame.setAttribute('allowtransparency', 'true')
  // Extension page URL (chrome-extension://<id>/src/popup/index.html).
  let popupUrl = ''
  try {
    popupUrl = chrome.runtime.getURL('src/popup/index.html')
  } catch {
    popupUrl = ''
  }
  if (popupUrl) frame.src = popupUrl
  panel.appendChild(head)
  panel.appendChild(frame)

  fab.addEventListener('click', () => {
    const open = panel.classList.toggle('open')
    fab.style.display = open ? 'none' : 'grid'
  })
  close.addEventListener('click', () => {
    panel.classList.remove('open')
    fab.style.display = 'grid'
  })

  shadow.appendChild(fab)
  shadow.appendChild(panel)
}
