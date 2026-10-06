import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  suggestedModelIds,
  fetchModelsHttp,
  getProviderModels,
  type ModelChoice,
} from '../src/ai/models'

describe('suggestedModelIds', () => {
  it('preselects DeepSeek V4.1 Flash first for huggingface (cheap vision)', () => {
    const ids = suggestedModelIds('huggingface')
    expect(ids[0]).toBe('deepseek-ai/DeepSeek-V4.1-Flash')
    expect(ids).toContain('deepseek-ai/DeepSeek-V4-Flash-Vision-Exp')
  })
  it('returns local ollama vision suggestions', () => {
    expect(suggestedModelIds('local')).toContain('qwen3:8b')
  })
  it('returns openrouter vision suggestions', () => {
    expect(suggestedModelIds('openrouter')).toContain('qwen/qwen-2.5-vl-72b-instruct')
  })
})

describe('fetchModelsHttp', () => {
  beforeEach(() => {
    vi.stubGlobal('AbortSignal', { timeout: () => undefined })
  })

  it('parses OpenAI-style { data: [{ id }] } list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'a/model' }, { id: 'b/model' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const list = await fetchModelsHttp('https://router.huggingface.co/v1', 'tok')
    expect(list).toEqual(['a/model', 'b/model'])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://router.huggingface.co/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
  })

  it('throws on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    await expect(fetchModelsHttp('https://x/v1', 'k')).rejects.toThrow('500')
  })
})

describe('getProviderModels (cache persistence)', () => {
  const store: Record<string, any> = {}
  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k])
    ;(globalThis as any).chrome = {
      storage: {
        local: {
          get: async (k: string | string[]) => {
            const keys = Array.isArray(k) ? k : [k]
            const out: Record<string, any> = {}
            for (const key of keys) if (key in store) out[key] = store[key]
            return out
          },
          set: async (obj: Record<string, any>) => Object.assign(store, obj),
        },
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
  })

  it('returns suggestions + catalog even when provider unreachable', async () => {
    const choices = await getProviderModels({
      provider: 'huggingface',
      baseUrl: 'https://router.huggingface.co/v1',
      apiKey: 'k',
    })
    const first: ModelChoice = choices[0]
    expect(first.id).toBe('deepseek-ai/DeepSeek-V4.1-Flash')
    expect(first.suggested).toBe(true)
  })

  it('persists fetched models and returns them from cache on second call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'deepseek-ai/DeepSeek-V4.1-Flash' },
            { id: 'some/new-model' },
          ],
        }),
      }),
    )
    const c1 = await getProviderModels({ provider: 'huggingface', baseUrl: 'https://router.huggingface.co/v1', apiKey: 'k' })
    expect(c1.some((m) => m.id === 'some/new-model')).toBe(true)

    // second call should hit the cache, not fetch again
    const spy = vi.mocked(fetch)
    spy.mockClear()
    const c2 = await getProviderModels({ provider: 'huggingface', baseUrl: 'https://router.huggingface.co/v1', apiKey: 'k' })
    expect(c2.some((m) => m.id === 'some/new-model')).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})
