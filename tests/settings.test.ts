import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  enabledProviders,
  hasUsableProvider,
  type Settings,
} from '../src/ai/settings'

describe('defaultSettings', () => {
  it('enables only local by default and setup not done', () => {
    const s = defaultSettings()
    expect(s.providers.filter((p) => p.enabled).map((p) => p.id)).toEqual(['local'])
    expect(s.setupDone).toBe(false)
    expect(s.scanModel).toBe('local')
  })
})

describe('enabledProviders / hasUsableProvider', () => {
  function makeSettings(over: Partial<Settings> = {}): Settings {
    return { ...defaultSettings(), ...over }
  }

  it('includes local (keyless) when enabled', () => {
    const s = makeSettings()
    expect(hasUsableProvider(s)).toBe(true)
    expect(enabledProviders(s).map((p) => p.id)).toEqual(['local'])
  })

  it('excludes cloud providers without an api key', () => {
    const s = makeSettings({
      providers: defaultSettings().providers.map((p) =>
        p.id === 'huggingface' ? { ...p, enabled: true, apiKey: '' } : p,
      ),
    })
    expect(enabledProviders(s).map((p) => p.id)).not.toContain('huggingface')
  })

  it('includes a cloud provider once a key is set', () => {
    const s = makeSettings({
      providers: defaultSettings().providers.map((p) =>
        p.id === 'huggingface' ? { ...p, enabled: true, apiKey: 'hf_abc' } : p,
      ),
    })
    expect(hasUsableProvider(s)).toBe(true)
    expect(enabledProviders(s).map((p) => p.id)).toContain('huggingface')
  })
})
