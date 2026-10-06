/**
 * ghostHR CV ingestion — PDF / Word / image → text → parsed CV.
 *
 * The user uploads their CV file (PDF, .docx, or an image). We never send the
 * raw file bytes to a provider unless the user has explicitly enabled a
 * non-local provider for CV processing; local-first means the OCR can run on a
 * local vision provider. The extracted text + structured profile are stored in
 * the local SQLite (cv_profiles).
 *
 * File → text strategy by type:
 *  - PDF: extract text directly (simple embedded text); if empty, fall back to
 *    rasterizing the first page to an image and asking a vision model.
 *  - Image (png/jpg/webp): send to vision model directly.
 *  - .docx: strip XML to text locally (zip + regex) — no provider needed.
 */

import { routeLlm } from './providers'
import { enabledProviders, type Settings } from './settings'
import { COMMON_SKILLS, type ParsedCv } from './verdict'

export type CvFileKind = 'pdf' | 'docx' | 'image'

export const CV_FILE_KINDS: Record<string, CvFileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'docx',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
}

export function detectCvKind(filename: string, mime?: string): CvFileKind {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (CV_FILE_KINDS[ext]) return CV_FILE_KINDS[ext]
  if (mime?.includes('pdf')) return 'pdf'
  if (mime?.includes('image')) return 'image'
  if (mime?.includes('word')) return 'docx'
  return 'pdf'
}

/** Convert a File/Blob into a data URL (for embedding into vision calls). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** ArrayBuffer → base64 (kept small for embedding). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

/** Extract plain text from a .docx/.doc zip package via XML. Pure, testable. */
export function extractDocxText(bytes: Uint8Array): Promise<string> {
  // Decompress zip in the popup/service-worker using native DecompressionStream.
  return (async () => {
    try {
      const ds = new DecompressionStream('deflate-raw')
      const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds)
      const raw = await new Response(stream).arrayBuffer()
      const text = new TextDecoder().decode(raw)
      // crude: pull <w:t> runs
      const runs = text.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? []
      return runs
        .map((r) => r.replace(/<\/?w:t[^>]*>/g, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    } catch {
      return ''
    }
  })()
}

const CV_PARSE_SYSTEM = `You are a ghostHR CV parser. Given a candidate's CV as text or an image,
extract structured profile data. Respond with ONLY strict JSON, no markdown:
{
  "name": "string",
  "email": "string",
  "phone": "string",
  "skills": ["string"],
  "years_experience": number,
  "education": ["string"],
  "projects": ["string"],
  "summary": "one-paragraph summary of the candidate"
}
Include a realistic years_experience number if inferable, else 0. skills should be
a plain list of keywords (e.g. "typescript", "react", "aws").`

export interface CvParseInput {
  settings: Settings
  /** Human-readable text if we already extracted it locally (docx/pdf). */
  text?: string
  /** Data URL of an image render (pdf page or an image file) for vision OCR. */
  imageDataUrl?: string
  signal?: AbortSignal
}

/**
 * Parse a CV through the routed AI providers. Prefers local extraction (text)
 * when available, otherwise sends the image to a vision provider. Returns
 * ParsedCv.
 *
 * Standalone-first: if no provider is configured/usable, or every provider
 * fails, falls back to a local heuristic parser (parseCvLocally) so the CV is
 * still usable offline — providers enhance, never gate. This is what keeps the
 * "Autofill form" / "Score my fit" actions from staying disabled forever just
 * because no AI provider is configured.
 */
export async function parseCv(input: CvParseInput): Promise<ParsedCv> {
  const providers = enabledProviders(input.settings).map((p) => ({
    id: p.id,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
  }))

  // Local text (pdf/docx) is free and always available — try it first.
  if (input.text && providers.length === 0) {
    return parseCvLocally(input.text)
  }

  try {
    const result = await routeLlm(
      providers,
      () => {
        const content: ChatMessageContent = [
          { type: 'text', text: 'Parse this CV and return the structured JSON profile.' },
        ]
        if (input.imageDataUrl) {
          content.push({ type: 'image_url', image_url: { url: input.imageDataUrl } })
        } else if (input.text) {
          content.push({ type: 'text', text: `CV text:\n${input.text?.slice(0, 20000)}` })
        }
        return [
          { role: 'system' as const, content: CV_PARSE_SYSTEM },
          { role: 'user' as const, content },
        ]
      },
      { signal: input.signal, maxTokens: 1024 },
    )
    return parseCvJson(result.result.text)
  } catch (e: any) {
    // Standalone fallback: if we have local text (pdf/docx) and the LLM path
    // failed (no provider, offline, or an error), parse heuristically instead of
    // failing the whole upload.
    if (input.text) {
      return parseCvLocally(input.text)
    }
    throw e
  }
}

const COMMON_SKILL_SET = new Set(COMMON_SKILLS.map((s) => s.toLowerCase()))

/**
 * Local heuristic CV parser — zero-provider, offline-safe fallback.
 * Extracts name/email/phone, skills (against the shared vocabulary + inline
 * lists), years experience, education and projects from raw CV text. Pure +
 * unit-testable.
 */
export function parseCvLocally(text: string): ParsedCv {
  const t = (text ?? '').replace(/\r/g, '')
  const email =
    t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i)?.[0]?.toLowerCase() ?? undefined
  const phone =
    t.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/)?.[0]?.trim() ?? undefined
  const name = guessName(t)

  const skills = extractSkills(t)

  // Years of experience: "X+ years" / "X years" patterns.
  const yearsMatch = t.match(/(\d{1,2})\s*\+?\s*years?\b/i)
  const years_experience = yearsMatch ? Number(yearsMatch[1]) : undefined

  const education = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => /(bachelor|master|bsc|msc|mba|phd|degree|university|diploma)/i.test(l))
    .slice(0, 6)

  const projects = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => /(built|developed|led|create[d]?|project:|portfolio)/i.test(l))
    .filter((l) => l.length > 8 && l.length < 200)
    .slice(0, 8)

  const summary =
    t.split(/\n+/).find((l) => l.trim().length > 40 && !l.includes('@'))?.trim() ?? ''

  return {
    name,
    email,
    phone,
    skills,
    years_experience,
    education: education.length ? education : undefined,
    projects: projects.length ? projects : undefined,
    raw_text: summary || t.slice(0, 2000),
  }
}

function guessName(t: string): string | undefined {
  // First line that looks like a person's name (2-4 capitalized words, no digits).
  const line =
    t.split(/\n+/).find((l) => {
      const words = l.trim().split(/\s+/).filter(Boolean)
      return (
        words.length >= 2 &&
        words.length <= 4 &&
        words.every((w) => /^[A-Z][a-z]+$/.test(w) || /^[A-Z]\.?$/.test(w)) &&
        !/\d/.test(l)
      )
    })?.trim() ?? ''
  if (line) return line

  // Fallback for single-line text (e.g. pdfjs extracting a one-line CV):
  // the leading run of capitalized words before the first email/phone/skill
  // clue is usually the name.
  const head = t.slice(0, 60)
  const words = head.split(/\s+/)
  const leading = []
  for (const w of words) {
    if (/^[A-Z][a-z]+$/.test(w)) leading.push(w)
    else break
  }
  if (leading.length >= 2) return leading.join(' ')
  return undefined
}

function extractSkills(t: string): string[] {
  const found = new Set<string>()
  const lower = t.toLowerCase()
  // Known vocabulary present in the text.
  for (const s of COMMON_SKILLS) {
    if (new RegExp(`\\b${escapeRegex(s)}\\b`, 'i').test(t)) found.add(s)
  }
  // Inline comma / bullet-separated skill lists (e.g. "Skills: Python, React, SQL").
  const section = t.match(/(?:skills?|tech stack|technologies?)\s*[:\-]\s*([^\n]{0,200})/i)?.[1]
  if (section) {
    for (const item of section.split(/[,;•|]/)) {
      const w = item.trim()
      if (w && w.length >= 2 && w.length <= 30 && /^[a-z0-9+#.\s-]+$/i.test(w)) found.add(toTitleCase(w))
    }
  }
  if (found.size === 0 && lower.includes('skill')) found.add('communication')
  return [...found]
}

function toTitleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type ChatMessageContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>

/** Best-effort JSON extraction for the parsed CV. Pure + unit-testable. */
export function parseCvJson(text: string): ParsedCv {
  let candidate = text.trim()
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidate = fence[1].trim()
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first >= 0 && last > first) candidate = candidate.slice(first, last + 1)
  const obj = JSON.parse(candidate)
  if (typeof obj !== 'object' || obj === null) throw new Error('CV parse did not return an object')
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : []
  return {
    name: str(obj.name) || undefined,
    email: (str(obj.email) || '').toLowerCase() || undefined,
    phone: str(obj.phone) || undefined,
    skills: strList(obj.skills),
    years_experience: typeof obj.years_experience === 'number' ? obj.years_experience : undefined,
    education: strList(obj.education),
    projects: strList(obj.projects),
    raw_text: str(obj.summary) || text,
  }
}
