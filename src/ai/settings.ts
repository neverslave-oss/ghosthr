/**
 * ghostHR user settings — AI provider configuration + the scan model picker.
 *
 * This is what the popup's Settings tab edits (src/popup/App.vue). Settings
 * persist through chrome.storage.local (the MV3-sanctioned key/value store) and
 * are also mirrored into the local SQLite for a single source of truth when the
 * optional cloud sync arrives.
 */

import { PROVIDER_CATALOG, PROVIDER_ORDER, type ProviderId } from './providers'

export interface ProviderSettings {
  id: ProviderId
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
}

export type ThemePref = 'system' | 'light' | 'dark'

export interface Settings {
  /** Provider order used for routing (local-first by default). */
  providers: ProviderSettings[]
  /** Which model should scan the page (job + form fields). */
  scanModel: ProviderId
  /** Which model should OCR the CV file. */
  cvModel: ProviderId
  /** Autofill scanned fields into the ATS page automatically. */
  autofillEnabled: boolean
  /** UI colour theme: follow the OS, or force light/dark. */
  theme: ThemePref
  /** True once the user has completed the first-run setup screen. */
  setupDone: boolean
}

const STORAGE_KEY = 'ghosthr.settings'

export function defaultSettings(): Settings {
  return {
    providers: PROVIDER_ORDER.map((id) => ({
      id,
      enabled: id === 'local', // local-first: only local enabled by default (offline standalone)
      baseUrl: PROVIDER_CATALOG[id].defaultBaseUrl,
      apiKey: '',
      model: PROVIDER_CATALOG[id].models[0],
    })),
    scanModel: 'local',
    cvModel: 'local',
    autofillEnabled: true,
    theme: 'system',
    setupDone: false,
  }
}

export async function loadSettings(): Promise<Settings> {
  const defaults = defaultSettings()
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY)
    if (got?.[STORAGE_KEY]) {
      return mergeSettings(defaults, got[STORAGE_KEY])
    }
  } catch {
    /* storage unavailable (non-extension context) -> fall back to defaults */
  }
  return defaults
}

export async function saveSettings(s: Settings): Promise<void> {
  const clean = {
    ...s,
    theme: s.theme,
    providers: s.providers.map((p) => ({
      id: p.id,
      enabled: p.enabled,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
    })),
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: clean })
  } catch {
    /* no-op outside extension context */
  }
}

function mergeSettings(defaults: Settings, stored: Partial<Settings>): Settings {
  const providers = defaults.providers.map((def) => {
    const s = (stored.providers ?? []).find((p: any) => p.id === def.id)
    return {
      ...def,
      ...(s ?? {}),
    }
  })
  const theme = ['system', 'light', 'dark'].includes(stored.theme as string)
    ? (stored.theme as ThemePref)
    : defaults.theme
  return {
    providers,
    scanModel: (stored.scanModel as ProviderId) || defaults.scanModel,
    cvModel: (stored.cvModel as ProviderId) || defaults.cvModel,
    autofillEnabled: stored.autofillEnabled ?? defaults.autofillEnabled,
    theme,
    setupDone: stored.setupDone ?? defaults.setupDone,
  }
}

/** Resolve the enabled providers in configured order for a routing pass. */
export function enabledProviders(settings: Settings) {
  return settings.providers
    .filter((p) => {
      if (!p.enabled || !p.baseUrl || !p.model) return false
      // Cloud providers are unusable without a key; only `local` may run keyless.
      return p.id === 'local' || Boolean(p.apiKey)
    })
    .slice()
}

/** Whether any provider is actually usable (enabled + reachable config). */
export function hasUsableProvider(settings: Settings): boolean {
  return enabledProviders(settings).length > 0
}
