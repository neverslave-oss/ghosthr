// ghostHR deep agent — in-process, runs in the Electron main process.
//
// Full-surface deep agent built on @langchain/langgraph createReactAgent
// (the stable prebuilt in @langchain/langgraph 1.4.19). It augments the
// deterministic verdict engine (analyze()) by adding:
//   - coach tools that read the CURRENT scan + CV + applications DB
//   - a virtual filesystem (VFS) for user file uploads/management
//   - live web research
//   - planning + subagent-style delegation + streaming to the Agent chat UI
//
// Model is routed by the extension's provider settings (local-first ->
// HuggingFace -> Doubleword -> OpenRouter), all OpenAI-compatible, so any
// configured tool-calling model works.
const { createReactAgent } = require('@langchain/langgraph/prebuilt')
const { MemorySaver } = require('@langchain/langgraph-checkpoint')
const { ChatOpenAI } = require('@langchain/openai')
const { ChatOllama } = require('@langchain/ollama')
const { tool } = require('@langchain/core/tools')
const { z } = require('zod')

/**
 * Build the model object for a provider config. All ghostHR providers are
 * OpenAI-compatible chat-completions endpoints, so ChatOpenAI covers HF /
 * Doubleword / OpenRouter; local Ollama/vLLM uses ChatOllama (base_url) or
 * ChatOpenAI-with-baseUrl when possible.
 * @param {{id:string, baseUrl:string, apiKey?:string, model:string}} p
 */
function modelForProvider(p) {
  const base = String(p.baseUrl || '').replace(/\/+$/, '')
  const model = p.model || 'gpt-4o'
  if (p.id === 'local') {
    // Ollama/vLLM via OpenAI-compatible path when baseUrl is a /v1 endpoint.
    return new ChatOpenAI({ model, apiKey: p.apiKey || 'ollama', configuration: { baseURL: base } })
  }
  if (!p.apiKey) throw new Error(`Provider ${p.id} has no API key set`)
  // HF/Doubleword/OpenRouter: OpenAI-compatible with bearer key.
  return new ChatOpenAI({ model, apiKey: p.apiKey, configuration: { baseURL: base || undefined } })
}

/**
 * Choose the first enabled, model-bearing provider for this agent turn,
 * honoring the scanModel/settings order. Returns null if none configured.
 */
function pickProvider(settings) {
  if (!settings?.providers || !Array.isArray(settings.providers)) return null
  const order = (settings.providerOrder ?? settings.providers.map((p) => p.id)) || []
  const enabled = settings.providers.filter((p) => p.enabled && p.model)
  if (!enabled.length) return null
  // Respect configured order; fall back to first enabled.
  const ranked = enabled.slice().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  return ranked[0]
}

const SYSTEM_PROMPT = `You are ghostHR's deep-agent coach. You help a job candidate decide
whether a job is worth applying to and, crucially, what to DO FIRST to make it
worth it (the "hold back" coaching that differentiates ghostHR).

You have access to:
- get_agent_context: the current job scan (title, company, description, fields)
  plus the candidate's parsed CV and the deterministic baseline verdict.
- get_applications: the candidate's tracked applications (evidence of what they
  apply to / whether employers ghost).
- vfs_list / vfs_read / vfs_write: a private virtual workspace for the user's
  files (resume, cover letters, notes). Use it to store/retrieve user content.
- web_search: live research on the employer/role/industry.

Approach:
1. Gather context (scan + CV). If either is missing, TELL the user what to do
   (scan the job / add CV) — do not fabricate.
2. Research when it would materially improve the coaching (employer reputation,
   actual role scope, skills demand). Keep it targeted, not exhaustive.
3. Synthesize a concrete verdict + specific hold-back actions with effort
   estimates, grounded in the real gap between the candidate and the role.
4. Use the VFS to save any user-facing artifacts the user asks for.

Output coaching as plain text the user reads directly. Be specific and honest —
if the data is thin, say so and recommend the missing step, don't bluff.`

/**
 * Build the deep agent.
 * @param {object} deps
 * @param {() => Promise<object>} deps.getAgentContext  - scan+CV+baseline verdict
 * @param {() => Promise<object[]>} deps.getApplications  - tracked applications
 * @param {import('./vfs').Vfs} deps.vfs  - virtual filesystem
 * @param {(q:string) => Promise<string>} deps.webSearch - live research (pluggable)
 * @param {(settings:object) => object|null} deps.resolveModel - model factory from settings
 */
async function buildDeepAgent(deps) {
  const readScanCv = tool(
    async () => {
      try {
        const ctx = await deps.getAgentContext()
        return JSON.stringify(
          { scan: ctx.scan || null, cv: ctx.cv || null, baselineVerdict: ctx.verdict || null },
          null,
          2,
        )
      } catch (e) {
        return `[get_agent_context unavailable: ${e && e.message}]`
      }
    },
    {
      name: 'get_agent_context',
      description:
        'Returns the current job scan (title, company, description, form fields), the candidate parsed CV, and the deterministic baseline verdict.',
      schema: z.object({}),
    },
  )

  const readApps = tool(
    async () => {
      try {
        const apps = await deps.getApplications()
        return JSON.stringify(apps, null, 2)
      } catch (e) {
        return `[get_applications unavailable: ${e && e.message}]`
      }
    },
    {
      name: 'get_applications',
      description: 'Returns the candidate tracked applications (company, role, stage, outcome).',
      schema: z.object({}),
    },
  )

  const vfsList = tool(
    async ({ path }) => deps.vfs.list(path || '/'),
    { name: 'vfs_list', description: 'List files in the virtual workspace. Path defaults to "/".', schema: z.object({ path: z.string().optional() }) },
  )

  const vfsRead = tool(
    async ({ path }) => {
      const r = await deps.vfs.read(path)
      return r.found ? r.content : `[not found: ${path}]`
    },
    { name: 'vfs_read', description: 'Read a file path from the virtual workspace.', schema: z.object({ path: z.string() }) },
  )

  const vfsWrite = tool(
    async ({ path, content }) => deps.vfs.write(path, content),
    { name: 'vfs_write', description: 'Write/overwrite a file path in the virtual workspace.', schema: z.object({ path: z.string(), content: z.string() }) },
  )

  const webSearch = tool(
    async ({ query }) => {
      try {
        const r = await deps.webSearch(query)
        return r || '[web_search returned no results]'
      } catch (e) {
        return `[web_search unavailable: ${e && e.message}]`
      }
    },
    { name: 'web_search', description: 'Live web research on the employer, role, or industry.', schema: z.object({ query: z.string() }) },
  )

  const tools = [readScanCv, readApps, vfsList, vfsRead, vfsWrite, webSearch]

  // Resolve model from settings via injected factory; fall back to null (the
  // agent construction needs a model, so require one).
  const settings = await deps.getSettings()
  let model = deps.resolveModel ? deps.resolveModel(settings) : null
  if (!model) {
    const p = pickProvider(settings)
    if (!p) throw new Error('No enabled, model-bearing AI provider configured. Enable one in ghostHR Settings.')
    model = modelForProvider(p)
  }

  const agent = createReactAgent({
    llm: model,
    tools,
    messageModifier: SYSTEM_PROMPT,
    checkpointer: new MemorySaver(),
  })

  return {
    agent,
    modelUsed: model,
    tools: tools.map((t) => t.name),
  }
}

module.exports = { buildDeepAgent, modelForProvider, pickProvider }
