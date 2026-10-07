/**
 * ghostHR ATS form detector.
 *
 * Recognizes "application form" pages (Workable and generic ATS flows): a job
 * description block on top plus prefillable fields (textareas/inputs). Pure,
 * testable against DOM-like structures. Kept separate from DOM-touching code so
 * tests don't need a real browser.
 */

export interface AthFormField {
  kind: 'textarea' | 'input' | 'select' | 'checkbox' | 'file'
  name: string | null
  label: string | null
  placeholder: string | null
  required: boolean
}

export interface DetectedForm {
  provider: 'workable' | 'generic'
  descriptionText: string
  fields: AthFormField[]
  /** URL of the actual application form when this is an overview/description page. */
  applyUrl?: string | null
}

export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Detect a known ATS provider from the URL + page evidence.
 * Pure — takes strings, returns a label.
 */
export function detectProvider(url: string, bodyText: string): 'workable' | 'generic' {
  const lower = url.toLowerCase()
  if (lower.includes('workable.com')) return 'workable'
  if (
    /(greenhouse|lever|bamboohr|ashbyhq|smartrecruiters|workday|icims)/i.test(url) ||
    /workable|greenhouse|lever|ashby/i.test(bodyText)
  ) {
    return 'generic'
  }
  return 'generic'
}

/**
 * Extract the job-description block from a page. In Workable-style flows the
 * description sits above the form. Pure heuristic: take the largest text block
 * before the first form field.
 */
export function extractJobDescription(
  bodyText: string,
  firstFieldIndex: number,
): string {
  const text = bodyText
  const slice = firstFieldIndex > 0 ? text.slice(0, firstFieldIndex) : text
  // crude: return the longest paragraph-ish run
  const paragraphs = slice.split(/\n+/).map(normalizeText).filter((p) => p.length > 0)
  paragraphs.sort((a, b) => b.length - a.length)
  return paragraphs[0] ?? ''
}

/**
 * Given an array of candidate form-field descriptors and the document text,
 * return a DetectedForm. The caller (content script) adapts a real DOM into
 * this pure shape for testing.
 */
export function buildDetectedForm(input: {
  url: string
  bodyText: string
  fields: AthFormField[]
  firstFieldIndex: number
  applyUrl?: string | null
}): DetectedForm {
  const provider = detectProvider(input.url, input.bodyText)
  const descriptionText = extractJobDescription(input.bodyText, input.firstFieldIndex)
  return {
    provider,
    descriptionText,
    fields: input.fields,
    applyUrl: input.applyUrl ?? null,
  }
}

/**
 * Map a common label to a CV field so we can prefill.
 * Pure label -> field mapping.
 */
export function mapFieldName(label: string | null, placeholder: string | null): string | null {
  const hay = normalizeText(`${label ?? ''} ${placeholder ?? ''}`).toLowerCase()
  if (!hay) return null
  if (/(first|candidate first|given).*name|^name$/i.test(hay)) return 'first_name'
  if (/(last|family|surname).*name/i.test(hay)) return 'last_name'
  if (/email/i.test(hay)) return 'email'
  if (/phone|mobile|tel/i.test(hay)) return 'phone'
  if (/linkedin/i.test(hay)) return 'linkedin_url'
  if (/website|portfolio|github/i.test(hay)) return 'website'
  if (/cover letter|why (you|this)|message|description of yourself/i.test(hay)) {
    return 'cover_letter'
  }
  if (/(resume|cv|application file|attach)/i.test(hay)) return 'resume'
  if (/city|location|address/i.test(hay)) return 'location'
  return null
}

/**
 * True if the text looks like a job *advert* page at all (heading + apply
 * language) — even if no prefillable fields are present (e.g. a Workable
 * overview page whose form lives on a separate /apply/ URL).
 */
export function looksLikeJobAdvert(bodyText: string): boolean {
  return /(job|position|apply for this job|apply now|candidate|we are looking for|about the role|requirements|responsibilities|full time|remote)/i.test(
    bodyText,
  )
}

/**
 * True if the page looks like an application form at all (has prefillable
 * text fields). Pure.
 */
export function looksLikeApplicationForm(fields: AthFormField[], bodyText: string): boolean {
  const textFields = fields.filter((f) => f.kind === 'textarea' || f.kind === 'input')
  // A file-upload field (CV/resume attach) is the strongest ATS form signal.
  const hasFileUpload = fields.some((f) => f.kind === 'file')
  const hasJobSignal = /job|position|apply|candidate|application/i.test(bodyText)
  return (textFields.length >= 2 || hasFileUpload) && hasJobSignal
}
