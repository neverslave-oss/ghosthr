/**
 * ghostHR page scanner — full-page screenshot to structured job + form fields.
 *
 * The user clicks "Scan job", we capture a full-page screenshot of the current
 * tab, send it to the configured vision model (the `scanModel` in settings),
 * and get back a strict JSON object with the job description and the form
 * fields the candidate has to fill. Those fields are then surfaced in the popup
 * and autofilled into the page (src/content/autofill.ts).
 *
 * Scanning must be robust to ATS DOM churn: we rely on the vision model reading
 * the rendered pixels, not brittle selectors.
 */

import { routeLlm } from './providers'
import { enabledProviders, type Settings } from './settings'

export interface ScannedField {
  label: string
  kind: 'input' | 'textarea' | 'select' | 'checkbox'
  required: boolean
  /** Value to prefill (from CV) once the scanned-CV OCR has run. */
  value?: string
}

export interface PageScan {
  jobTitle: string
  company: string
  jobDescription: string
  fields: ScannedField[]
}

const SCAN_SYSTEM = `You are a ghostHR page scanner. You receive a full-page screenshot of a job
application page (an ATS like Workable, Greenhouse, Lever, or a generic form).
Extract the job advertisement details AND the list of form fields the candidate
must fill in to apply.

Respond with ONLY strict JSON, no markdown, no commentary:
{
  "jobTitle": "string",
  "company": "string",
  "jobDescription": "the full job description text, complete and verbatim as long as it is",
  "fields": [
    {"label": "human-readable field label", "kind": "input|textarea|select|checkbox", "required": true|false}
  ]
}

Include every prefillable field (name, email, phone, LinkedIn, resume upload,
cover letter, location, etc.). For the resume/file fields use kind "input".
If you cannot identify a job advert on the page, return an empty object.`

export interface ScanProviderInput {
  settings: Settings
  screenshotDataUrl: string
  signal?: AbortSignal
}

/**
 * Run a full-page scan through the routed AI providers. Returns the parsed
 * PageScan. Throws if every provider fails or JSON cannot be parsed.
 */
export async function scanPage(input: ScanProviderInput): Promise<PageScan> {
  const providers = enabledProviders(input.settings)
  const configured = providers.map((p) => ({
    id: p.id,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
  }))

  const { result } = await routeLlm(
    configured,
    () => [
      {
        role: 'system',
        content: SCAN_SYSTEM,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Scan this job application page and return the structured JSON.' },
          { type: 'image_url', image_url: { url: input.screenshotDataUrl } },
        ],
      },
    ],
    { signal: input.signal, maxTokens: 2048 },
  )

  return parseScanJson(result.text)
}

/**
 * Best-effort JSON extraction from an LLM response (strip code fences / prose).
 * Pure + unit-testable.
 */
export function parseScanJson(text: string): PageScan {
  let candidate = text.trim()
  // strip ```json ... ``` fences
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidate = fence[1].trim()
  // fall back: first { to last }
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first >= 0 && last > first) candidate = candidate.slice(first, last + 1)
  const obj = JSON.parse(candidate)
  if (typeof obj !== 'object' || obj === null) throw new Error('Scan did not return a JSON object')
  const fields = Array.isArray(obj.fields)
    ? (obj.fields as any[]).map((f, idx) => ({
        label: String(f?.label ?? f?.name ?? `Field ${idx + 1}`),
        kind: normalizeKind(f?.kind),
        required: Boolean(f?.required),
        value: f?.value ? String(f.value) : undefined,
      }))
    : []
  return {
    jobTitle: String(obj.jobTitle ?? ''),
    company: String(obj.company ?? ''),
    jobDescription: String(obj.jobDescription ?? ''),
    fields,
  }
}

function normalizeKind(k: unknown): ScannedField['kind'] {
  const s = String(k ?? '').toLowerCase()
  if (s.includes('textarea')) return 'textarea'
  if (s.includes('checkbox')) return 'checkbox'
  if (s.includes('select')) return 'select'
  return 'input'
}
