/**
 * ghostHR desktop — Settings panel.
 *
 * Native desktop Settings that read/write the SAME chrome.storage.local the
 * standalone browser extension uses (via the extension bridge). Because the
 * desktop embeds the built extension in the same session, changing a provider
 * here is instantly in effect for the embedded webview, and it matches the
 * extension popup's Settings tab.
 *
 * Provider catalog mirrors src/ai/providers.ts (kept local so this module is
 * self-contained and not coupled to the extension TS build).
 */

import { getSettings, saveSettings, getCv, parseCv } from './ghostBridge.js'

const PROVIDERS = [
  { id: 'local', label: 'Local (Ollama / vLLM)', defaultBaseUrl: 'http://localhost:11434/v1',
    desc: 'Private models on your machine. No data leaves the device.',
    keyLabel: 'Key (optional for local)', models: ['qwen2.5vl:7b', 'llama3.2-vision:11b', 'minicpm-v:8b', 'qwen3:8b'] },
  { id: 'huggingface', label: 'Hugging Face', defaultBaseUrl: 'https://router.huggingface.co/v1',
    desc: 'Hugging Face Inference Providers (serverless).',
    keyLabel: 'HF token', models: ['Qwen/Qwen2.5-VL-7B-Instruct', 'meta-llama/Llama-3.2-11B-Vision-Instruct'] },
  { id: 'doubleword', label: 'Doubleword', defaultBaseUrl: 'https://api.doubleword.ai/v1',
    desc: 'Cheap async inference endpoint.', keyLabel: 'API key',
    models: ['doubleword/qwen3-32b', 'doubleword/gemini-2.5-pro'] },
  { id: 'openrouter', label: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api/v1',
    desc: 'One key, many models (vision too).', keyLabel: 'OpenRouter key',
    models: ['qwen/qwen-2.5-vl-72b-instruct', 'openai/gpt-4o', 'anthropic/claude-3-5-sonnet'] },
]

/** Render the Settings panel into `root`. Returns an async load() to populate. */
export function mountSettings(root) {
  let settings = null
  let cvInfo = null

  const el = document.createElement('div')
  el.className = 'settings-panel'

  const render = () => {
    if (!settings) { el.innerHTML = '<p class="empty">Loading settings…</p>'; return }

    const provCards = PROVIDERS.map((p) => {
      const pv = settings.providers.find((x) => x.id === p.id) || { id: p.id, enabled: false, baseUrl: p.defaultBaseUrl, apiKey: '', model: p.models[0] }
      return `
        <div class="provider" data-prov="${p.id}">
          <label class="provhead">
            <input type="checkbox" data-field="enabled" data-prov="${p.id}" ${pv.enabled ? 'checked' : ''} />
            <b>${p.label}</b>
          </label>
          <p class="hint">${p.desc}</p>
          <label class="field-label">Base URL</label>
          <input type="text" data-field="baseUrl" data-prov="${p.id}" value="${escapeHtml(pv.baseUrl || '')}" />
          <label class="field-label">${p.keyLabel}</label>
          <input type="password" data-field="apiKey" data-prov="${p.id}" placeholder="${p.keyLabel}" value="${escapeHtml(pv.apiKey || '')}" />
          <label class="field-label">Model</label>
          <select data-field="model" data-prov="${p.id}">
            ${p.models.map((m) => `<option value="${m}" ${pv.model === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>`
    }).join('')

    const scanOpts = PROVIDERS.map((p) => `<option value="${p.id}" ${settings.scanModel === p.id ? 'selected' : ''}>${p.label}</option>`).join('')
    const cvOpts = PROVIDERS.map((p) => `<option value="${p.id}" ${settings.cvModel === p.id ? 'selected' : ''}>${p.label}</option>`).join('')

    el.innerHTML = `
      <section class="section">
        <h2>AI providers</h2>
        <p class="hint">Shared with the ghostHR browser extension — change once, synced both places.</p>
        ${provCards}
      </section>
      <section class="section">
        <h2>Scan model</h2>
        <p class="hint">Which provider scans pages for job + form fields.</p>
        <select data-model-field="scanModel">${scanOpts}</select>
      </section>
      <section class="section">
        <h2>CV OCR model</h2>
        <p class="hint">Which provider reads and extracts your CV.</p>
        <select data-model-field="cvModel">${cvOpts}</select>
      </section>
      <section class="section">
        <label class="provhead">
          <input type="checkbox" data-boolean-field="autofillEnabled" ${settings.autofillEnabled ? 'checked' : ''} />
          <b>Autofill scanned fields automatically</b>
        </label>
      </section>
      <section class="section">
        <h2>My CV</h2>
        <p class="hint" id="cv-status">${cvInfo ? `Loaded: ${cvInfo.name}` : 'No CV stored yet.'}</p>
        <label class="file-btn">
          <input type="file" id="cv-file" accept=".pdf,.docx,image/*" style="display:none" />
          Upload CV
        </label>
        <button class="ghost" id="cv-refresh">Refresh</button>
      </section>
      <div class="settings-actions">
        <button class="primary" id="settings-save">Save settings</button>
        <button class="ghost" id="settings-cancel">Reset</button>
      </div>
      <p class="hint" id="settings-status"></p>
    `
    bindEvents()
  }

  const bindEvents = () => {
    // Provider fields
    el.querySelectorAll('.provider').forEach((card) => {
      const pid = card.dataset.prov
      const pv = settings.providers.find((x) => x.id === pid)
      card.querySelectorAll('[data-field]').forEach((field) => {
        const f = field.dataset.field
        const onInput = (ev) => {
          let val = ev.target.value
          if (f === 'enabled') val = ev.target.checked
          pv[f] = val
        }
        field.addEventListener(f === 'enabled' ? 'change' : 'input', onInput)
      })
    })
    // Top-level model selects + boolean
    el.querySelectorAll('[data-model-field]').forEach((sel) => {
      sel.addEventListener('change', (ev) => { settings[ev.target.dataset.modelField] = ev.target.value })
    })
    el.querySelectorAll('[data-boolean-field]').forEach((box) => {
      box.addEventListener('change', (ev) => { settings[ev.target.dataset.booleanField] = ev.target.checked })
    })
    // CV file
    const cvFile = el.querySelector('#cv-file')
    if (cvFile) cvFile.addEventListener('change', onCvFile)
    const cvRefresh = el.querySelector('#cv-refresh')
    if (cvRefresh) cvRefresh.addEventListener('click', refreshCv)
    // Actions
    const saveBtn = el.querySelector('#settings-save')
    if (saveBtn) saveBtn.addEventListener('click', onSave)
    const cancelBtn = el.querySelector('#settings-cancel')
    if (cancelBtn) cancelBtn.addEventListener('click', load)
  }

  const setStatus = (msg, isErr = false) => {
    const s = el.querySelector('#settings-status')
    if (s) { s.textContent = msg; s.style.color = isErr ? 'var(--bad)' : '' }
  }

  const refreshCv = async () => {
    try { cvInfo = await getCv(); render() } catch (e) { setStatus('CV read failed: ' + (e && e.message), true) }
  }

  const onCvFile = async (ev) => {
    const file = ev.target.files && ev.target.files[0]
    if (!file) return
    setStatus(`Reading ${file.name}…`)
    try {
      const input = { name: file.name }
      const isImg = /image\//i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name)
      const isDocx = /\.docx$/i.test(file.name)
      if (isImg || (isDocx === false && file.name.toLowerCase().endsWith('.pdf') === false && !/pdf$/i.test(file.name))) {
        // image -> data URL
        input.imageDataUrl = await fileToDataUrl(file)
      } else if (isDocx) {
        input.text = await readFileText(file)
      } else {
        // pdf or text
        input.text = await readFileText(file)
      }
      const res = await parseCv(input)
      if (!res.ok) throw new Error(res.error || 'parse failed')
      cvInfo = { name: file.name }
      setStatus(`CV parsed: ${file.name}`)
      render()
    } catch (e) {
      setStatus('CV parse failed: ' + (e && e.message), true)
    }
  }

  const onSave = async () => {
    try {
      await saveSettings(settings)
      setStatus('Settings saved (synced with the extension).')
    } catch (e) {
      setStatus('Save failed: ' + (e && e.message), true)
    }
  }

  const load = async () => {
    try {
      settings = await getSettings()
      try { cvInfo = await getCv() } catch { cvInfo = null }
      render()
    } catch (e) {
      el.innerHTML = `<p class="empty">Could not load settings: ${escapeHtml(e && e.message)}</p>`
    }
  }

  root.appendChild(el)
  load()
  return { load, save: onSave }
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file) }) }
function readFileText(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file) }) }

// Auto-wire if the container exists (used when loaded as a plain script).
export async function init() {
  const root = document.getElementById('settings-root')
  if (root) mountSettings(root)
}
