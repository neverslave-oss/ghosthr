/**
 * ghostHR provider model catalog — dynamic model fetching with caching.
 *
 * The model lists are fetched from each provider's OpenAI-compatible /models
 * endpoint the first time the user opens the model picker, then cached in
 * chrome.storage.local so we don't refetch on every popup open. The cache also
 * falls back to the static catalog (PROVIDER_CATALOG[].models) so the picker
 * always has suggestions even before the first successful fetch.
 */

import { PROVIDER_CATALOG, type ProviderId } from './providers'

/** A model entry offered in the picker. */
export interface ModelChoice {
  id: string
  /** True when this is a recommended model for ghostHR's vision tasks. */
  suggested: boolean
}

const CACHE_KEY = 'ghosthr.models_cache'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // refetch at most once per 24h

interface ProviderCache {
  fetchedAt: number
  models: string[]
}

const ALLOWED_IDS: ProviderId[] = ['local', 'huggingface', 'doubleword', 'openrouter']

function sanitize(id: unknown): ProviderId | null {
  return typeof id === 'string' && (ALLOWED_IDS as string[]).includes(id) ? (id as ProviderId) : null
}

/** List HF + other OpenAI-compatible providers' models via their /models endpoint. */
export async function fetchModelsHttp(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/models'
  const headers: Record<string, string> = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Failed to fetch models (HTTP ${res.status})`)
  const data = await res.json()
  const list: unknown[] = Array.isArray(data) ? (data as unknown[]) : ((data?.data as unknown[]) ?? [])
  return list
    .map((m) => (typeof m === 'string' ? m : (m as any)?.id))
    .filter((id): id is string => typeof id === 'string' && (id as string).length > 0)
}

/** Models we recommend for ghostHR tasks (vision scanning + OCR), per provider. */
export function suggestedModelIds(provider: ProviderId): string[] {
  switch (provider) {
    case 'huggingface':
      return [
        'deepseek-ai/DeepSeek-V4.1-Flash',
        'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
        'Qwen/Qwen3-VL-30B-A3B-Instruct',
        'Qwen/Qwen2.5-VL-7B-Instruct',
      ]
    case 'local':
      return ['qwen3:8b', 'qwen2.5vl:7b', 'llama3.2-vision:11b']
    case 'doubleword':
      return ['doubleword/qwen3-32b', 'doubleword/gemini-2.5-pro']
    case 'openrouter':
      return ['qwen/qwen-2.5-vl-72b-instruct', 'openai/gpt-4o-mini']
    default:
      return []
  }
}

/** Read the persisted model cache (best-effort; storage may be unavailable in tests). */
async function readCache(): Promise<Record<string, ProviderCache>> {
  try {
    const got = await chrome.storage.local.get(CACHE_KEY)
    return (got?.[CACHE_KEY] as Record<string, ProviderCache>) ?? {}
  } catch {
    return {}
  }
}

/** Persist the model cache. */
async function writeCache(cache: Record<string, ProviderCache>): Promise<void> {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: cache })
  } catch {
    /* non-extension context — cache simply won't persist */
  }
}

/**
 * Return the merged model list for a provider: cached fetch (if fresh) overlaid
 * on the static catalog + suggestions. Fetches from the provider the first time
 * (or after TTL) if a baseUrl+apiKey are available.
 */
export async function getProviderModels(input: {
  provider: ProviderId
  baseUrl: string
  apiKey?: string
  force?: boolean
}): Promise<ModelChoice[]> {
  const { provider, baseUrl, apiKey, force } = input

  // 1) catalog defaults + suggestions (always present)
  let list = [...(PROVIDER_CATALOG[provider]?.models ?? [])]
  for (const s of suggestedModelIds(provider)) {
    if (!list.includes(s)) list.push(s)
  }

  // 2) cached fetch
  const cache = await readCache()
  const entry = cache[provider]
  const fresh = entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS
  if (fresh && Array.isArray(entry.models) && entry.models.length) {
    for (const id of entry.models) if (!list.includes(id)) list.push(id)
    return rank(list, provider)
  }

  // 3) fetch (unless we have nothing to fetch against)
  if (baseUrl && !force && !fresh === false && entry) {
    // reuse even stale cache instead of failing the picker
    if (Array.isArray(entry.models) && entry.models.length) {
      for (const id of entry.models) if (!list.includes(id)) list.push(id)
      return rank(list, provider)
    }
  }
  try {
    const fetched = await fetchModelsHttp(baseUrl, apiKey)
    if (fetched.length) {
      cache[provider] = { fetchedAt: Date.now(), models: fetched }
      await writeCache(cache)
      for (const id of fetched) if (!list.includes(id)) list.push(id)
    }
  } catch {
    // provider unreachable — fall back to catalog + suggestions
  }
  return rank(list, provider)
}

/** Order by suggestions first, then the rest — flagging suggestions. */
function rank(list: string[], provider: ProviderId): ModelChoice[] {
  const suggestions = suggestedModelIds(provider)
  const out: ModelChoice[] = []
  const seen = new Set<string>()
  for (const s of suggestions) {
    if (list.includes(s)) {
      out.push({ id: s, suggested: true })
      seen.add(s)
    }
  }
  for (const id of list) {
    if (!seen.has(id)) out.push({ id, suggested: false })
  }
  return out
}
