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
import type { ParsedCv } from './verdict'

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
 */
export async function parseCv(input: CvParseInput): Promise<ParsedCv> {
  const providers = enabledProviders(input.settings).map((p) => ({
    id: p.id,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
  }))

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
