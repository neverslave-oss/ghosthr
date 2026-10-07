/**
 * ghostHR agent-generated autofill — fill the remaining form fields the
 * deterministic CV mapping can't (textareas, custom questions, cover letter,
 * salary, roles, etc.).
 *
 * We hand the job description + CV + the list of still-unfilled field labels
 * to the configured AI provider and get back a structured { label -> value }
 * map, then the content script fills each one. Deterministic CV fields
 * (name/email/phone/…) still fill instantly with no model round-trip; this
 * module only covers the gaps.
 */

import { routeLlm, type ProviderId } from './providers'
import type { Settings } from './settings'
import type { ParsedCv } from './verdict'
import type { ScannedField } from './scanner'

export interface GeneratedField {
  label: string
  value: string
}

const SYSTEM_PROMPT = `You are ghostHR's application autofill assistant. A candidate is
filling out a job application form and needs sensible, professional answers for
the fields that a CV cannot provide directly (free-text questions, cover
letters, salary expectations, current role, notice period, motivation, etc.).

You receive: the job description, the candidate's CV, and a list of field labels
still left blank. For each label, write a concise, tailored value a strong
candidate would actually submit — grounded in the real CV and job, never
fabricating experience or credentials.

Respond with ONLY strict JSON, no markdown, no commentary:
{ "fields": [ { "label": "<exact field label>", "value": "<filled value>" } ] }
Only include labels that were given and that you can answer meaningfully.`

/** Strip code fences / stray markers that providers sometimes wrap JSON in. */
export function parseGeneratedJson(text: string): GeneratedField[] {
  const cleaned = (text ?? '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const data = JSON.parse(cleaned.slice(start, end + 1))
    const fields = Array.isArray(data?.fields) ? data.fields : []
    return fields
      .map((f: any) => ({
        label: String(f?.label ?? '').trim(),
        value: String(f?.value ?? '').trim(),
      }))
      .filter((f: GeneratedField) => f.label && f.value)
  } catch {
    return []
  }
}

/**
 * Ask the configured providers to generate values for the given unfilled
 * fields. Returns an array of { label, value } pairs (deduped by label).
 */
export async function generateFieldValues(opts: {
  settings: Settings
  cv: ParsedCv
  jobDescription: string
  fields: ScannedField[]
}): Promise<GeneratedField[]> {
  const providers = opts.settings.providers
    .filter((p) => p.enabled)
    .map((p) => ({ id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }))
  if (!providers.length) return []

  const labels = opts.fields.map((f) => f.label).filter(Boolean)
  if (!labels.length) return []

  const cvLines = [
    opts.cv.name ? `Name: ${opts.cv.name}` : '',
    opts.cv.email ? `Email: ${opts.cv.email}` : '',
    opts.cv.phone ? `Phone: ${opts.cv.phone}` : '',
    opts.cv.years_experience != null ? `Years experience: ${opts.cv.years_experience}` : '',
    opts.cv.skills?.length ? `Skills: ${opts.cv.skills.join(', ')}` : '',
    opts.cv.raw_text ? `Full CV:\n${opts.cv.raw_text.slice(0, 3000)}` : '',
  ].filter(Boolean).join('\n')

  const userPrompt = [
    `Job description:\n${opts.jobDescription.slice(0, 4000)}`,
    `Candidate CV:\n${cvLines}`,
    `Blank fields to fill (fill only these labels):\n${labels.join('\n')}`,
  ].join('\n\n')

  try {
    const { result } = await routeLlm(providers as any, () => [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ])
    const parsed = parseGeneratedJson(result.text)
    const seen = new Set<string>()
    return parsed.filter((f) => {
      if (seen.has(f.label.toLowerCase())) return false
      seen.add(f.label.toLowerCase())
      return true
    })
  } catch {
    // Generation is best-effort — deterministic fill is unaffected on failure.
    return []
  }
}

// Re-exported so callers can build the deterministic bag + resolve remaining
// fields in one place.
export type { ProviderId }
