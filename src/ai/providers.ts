/**
 * ghostHR AI provider layer.
 *
 * ghostHR routes AI calls across four provider kinds and falls back along a
 * user-configurable order. Every provider is called through a single
 * OpenAI-compatible chat-completions interface (with optional inline image for
 * vision tasks), so adding/removing providers is just config.
 *
 * Configured in the popup Settings tab (see src/settings.ts). Each provider has
 * a base URL, an API key, and a selected model. The user can also pick "the
 * main model that should scan the page" — that's the `scanModel` selection in
 * settings.
 */

export type ProviderId = 'local' | 'huggingface' | 'doubleword' | 'openrouter'

export interface ProviderConfig {
  id: ProviderId
  label: string
  description: string
  defaultBaseUrl: string
  keyLabel: string
  /** Whether the provider is expected to reachable from a browser fetch. */
  browserCallable: boolean
  /** Example model ids for the picker. */
  models: string[]
  /** Provider can accept vision (image) inputs — needed for page scanning/OCR. */
  vision: boolean
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderConfig> = {
  local: {
    id: 'local',
    label: 'Local (Ollama / vLLM)',
    description: 'Private models on your machine (Ollama, vLLM, LM Studio). No data leaves the device.',
    defaultBaseUrl: 'http://localhost:11434/v1',
    keyLabel: 'Key (optional for local)',
    browserCallable: true,
    models: ['qwen2.5vl:7b', 'llama3.2-vision:11b', 'minicpm-v:8b', 'qwen3:8b'],
    vision: true,
  },
  huggingface: {
    id: 'huggingface',
    label: 'Hugging Face',
    description: 'Hugging Face Inference Providers (serverless).',
    defaultBaseUrl: 'https://router.huggingface.co/v1',
    keyLabel: 'HF token',
    browserCallable: true,
    models: ['Qwen/Qwen2.5-VL-7B-Instruct', 'meta-llama/Llama-3.2-11B-Vision-Instruct'],
    vision: true,
  },
  doubleword: {
    id: 'doubleword',
    label: 'Doubleword',
    description: 'Cheap async inference endpoint.',
    defaultBaseUrl: 'https://api.doubleword.ai/v1',
    keyLabel: 'API key',
    browserCallable: true,
    models: ['doubleword/qwen3-32b', 'doubleword/gemini-2.5-pro'],
    vision: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'One key, many models (vision too).',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyLabel: 'OpenRouter key',
    browserCallable: true,
    models: ['qwen/qwen-2.5-vl-72b-instruct', 'openai/gpt-4o', 'anthropic/claude-3-5-sonnet'],
    vision: true,
  },
}

export const PROVIDER_ORDER: ProviderId[] = ['local', 'huggingface', 'doubleword', 'openrouter']

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
}

export interface LlmCallOptions {
  baseUrl: string
  apiKey?: string
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  signal?: AbortSignal
}

export interface LlmResult {
  text: string
}

/**
 * Single OpenAI-compatible chat-completions call (supports inline images for
 * vision models). Throws on non-2xx with a readable message.
 */
export async function callLlm(opts: LlmCallOptions): Promise<LlmResult> {
  const url = opts.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 2048,
    }),
    // If the caller passed no abort signal, impose a strict default timeout so a
    // dead baseUrl (e.g. no local Ollama) can never hang the scan forever.
    signal: opts.signal ?? AbortSignal.timeout(20000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`AI call failed (${res.status}) for ${opts.model}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content ?? ''
  return { text }
}

/**
 * Attempt the configured providers in order until one succeeds. Returns the
 * first successful result plus the provider id that handled it. If all fail,
 * throws the last error enriched with every provider's failure.
 */
export async function routeLlm(
  providers: Array<{ id: ProviderId; baseUrl: string; apiKey?: string; model?: string }>,
  buildMessages: (provider: ProviderId) => ChatMessage[],
  opts?: { maxTokens?: number; signal?: AbortSignal },
): Promise<{ provider: ProviderId; result: LlmResult }> {
  const errors: string[] = []
  for (const p of providers) {
    if (!p.model) continue
    try {
      const result = await callLlm({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model,
        messages: buildMessages(p.id),
        maxTokens: opts?.maxTokens,
        signal: opts?.signal,
      })
      if (result.text.trim()) return { provider: p.id, result }
    } catch (e: any) {
      errors.push(`${p.id}: ${e?.message ?? e}`)
    }
  }
  throw new Error('All AI providers failed — ' + errors.join(' || '))
}
