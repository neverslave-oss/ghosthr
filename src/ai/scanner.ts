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
  kind: 'input' | 'textarea' | 'select' | 'checkbox' | 'file'
  required: boolean
  /** Value to prefill (from CV) once the scanned-CV OCR has run. */
  value?: string
}

export interface PageScan {
  jobTitle: string
  company: string
  jobDescription: string
  fields: ScannedField[]
  /** URL of the actual application form when this is an overview/description page. */
  applyUrl?: string | null
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
    // High output budget: the prompt asks for the FULL verbatim job
    // description, and a low maxTokens (e.g. 2048) silently truncates long
    // adverts at the model layer — which then gets stored and scored,
    // degrading [view raw] AND the fit verdict. Raise it so descriptions +
    // field lists aren't cut off.
    { signal: input.signal, maxTokens: 16000 },
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
    applyUrl: undefined,
  }
}

function normalizeKind(k: unknown): ScannedField['kind'] {
  const s = String(k ?? '').toLowerCase()
  if (s.includes('textarea')) return 'textarea'
  if (s.includes('checkbox')) return 'checkbox'
  if (s.includes('select')) return 'select'
  if (s.includes('file')) return 'file'
  return 'input'
}

/**
 * Shape of the free offline DOM detection (src/content/ats.ts DetectedForm),
 * kept decoupled so scanner.ts stays pure and unit-testable.
 */
export interface LocalDetectedForm {
  provider: string
  descriptionText: string
  fields: Array<{
    kind: string
    name?: string | null
    label?: string | null
    placeholder?: string | null
    required?: boolean
  }>
  /** URL of the actual application form when this is an overview/description page. */
  applyUrl?: string | null
}

/**
 * Convert a free offline DOM detection into a PageScan. This is the no-LLM
 * tier: it needs only the heuristic ATS detector (already in ats.ts). The
 * offline pass cannot reliably recover a job title/company, so those are left
 * empty; fields + description carry the signal.
 */
export function localDetectedToScan(form: LocalDetectedForm): PageScan {
  const fields = (form.fields ?? []).map((f, idx) => ({
    label: f.label ?? f.name ?? f.placeholder ?? `Field ${idx + 1}`,
    kind: normalizeKind(f.kind),
    required: Boolean(f.required),
  }))
  return {
    jobTitle: '',
    company: '',
    jobDescription: form.descriptionText ?? '',
    fields,
    applyUrl: form.applyUrl || null,
  }
}

/**
 * Minimum real text fields an offline DOM scan must recover before it can be
 * trusted instead of the full vision-LLM scan.
 */
const OFFLINE_MIN_FIELDS = 3

/**
 * True when a free offline DOM detection is too thin to rely on, in which
 * case the caller should fall through to the vision-LLM scan.
 *
 * Offline field detection on modern (React/Vue) ATS forms often captures only
 * a couple of inputs because labels live outside <label>, so a sparse result
 * means the vision model should read the rendered page for the full field set
 * (and the job title/company the offline pass can't recover).
 */
export function isOfflineScanSparse(scan: PageScan | null | undefined): boolean {
  if (!scan || !scan.fields?.length) return true
  if (!scan.jobDescription) return true
  return scan.fields.length < OFFLINE_MIN_FIELDS
}
