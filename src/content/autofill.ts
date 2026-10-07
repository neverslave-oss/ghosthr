/**
 * ghostHR autofill — fill the identified ATS form fields from the parsed CV.
 *
 * Runs in the content script against the live DOM. We map each scanned field
 * label to a CV value (via mapFieldName-like heuristics in src/content/ats.ts)
 * and set the corresponding input/textarea/select value, dispatching input
 * events so frameworks (React/Vue) register the change. Pure label→value
 * mapping lives in ats.ts; this module handles the DOM mutations.
 */

import type { ParsedCv } from '../ai/verdict'
import { mapFieldName } from './ats'
import type { ScannedField } from '../ai/scanner'

export interface CvValueBag {
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  linkedin_url?: string
  website?: string
  location?: string
  cover_letter?: string
}

/** Build a value bag from a parsed CV. Pure + testable. */
export function cvValueBag(cv: ParsedCv): CvValueBag {
  const bag: CvValueBag = {}
  // Name: first token is first name, rest is last name.
  if (cv.name) {
    const parts = cv.name.trim().split(/\s+/)
    bag.first_name = parts[0]
    if (parts.length > 1) bag.last_name = parts.slice(1).join(' ')
  }
  if (cv.email) bag.email = cv.email
  if (cv.phone) bag.phone = cv.phone
  const lower = cv.raw_text?.toLowerCase() ?? ''
  const li = cv.raw_text?.match(/linkedin\.com\/[^\s,;)]+/i)
  if (li) bag.linkedin_url = li[0]
  const web = cv.raw_text?.match(/https?:\/\/(?!.*linkedin\.com)[^\s,;)]+/i)
  if (web) bag.website = web[0]
  if (lower.includes('berlin') || lower.includes('rome') || lower.includes('london') || lower.includes('ankara')) {
    bag.location = lower.match(/(berlin|rome|london|ankara)/i)?.[0] ?? undefined
  }
  return bag
}

/** Resolve the value for a scanned field from a CV value bag. Pure + testable. */
export function resolveFieldValue(field: ScannedField, bag: CvValueBag): string | undefined {
  const mapped = mapFieldName(field.label, null)
  if (!mapped) return undefined
  switch (mapped) {
    case 'first_name': return bag.first_name
    case 'last_name': return bag.last_name
    case 'email': return bag.email
    case 'phone': return bag.phone
    case 'linkedin_url': return bag.linkedin_url
    case 'website': return bag.website
    case 'location': return bag.location
    case 'cover_letter': return bag.cover_letter
    default: return undefined
  }
}

/**
 * For a scanned field, find the best matching DOM element and fill it.
 * Uses the label text against input/textarea/select elements. Returns true if
 * a value was placed.
 */
/** Find the best-matching DOM element for a scanned field label. */
export function findFieldElement(
  field: ScannedField,
  root: Document | HTMLElement = document,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
  const labelText = (field.label ?? '').trim().toLowerCase()
  // Never fill without a usable label — a blind fallback would overwrite an
  // arbitrary (first) input on the page with an unrelated value.
  if (!labelText) return null
  const candidates = Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea, select',
    ),
  )
  const byLabel = candidates.filter((el) => {
    const lbl = (el.closest('label')?.textContent || (el as HTMLElement).getAttribute('aria-label') || '')
      .trim()
      .toLowerCase()
    const name = (el.getAttribute('name') || el.getAttribute('id') || '').toLowerCase()
    return (
      (lbl.length > 0 && (lbl.includes(labelText) || labelText.includes(lbl))) ||
      (name.length > 0 && name === labelText)
    )
  })
  return byLabel[0] ?? null
}

export function fillField(field: ScannedField, bag: CvValueBag, root: Document | HTMLElement = document): boolean {
  const value = resolveFieldValue(field, bag)
  if (!value) return false
  return fillFieldValue(field, value, root)
}

/** Fill a field with an explicit value (used for agent-generated answers). */
export function fillFieldValue(
  field: ScannedField,
  value: string,
  root: Document | HTMLElement = document,
): boolean {
  if (!value) return false
  const target = findFieldElement(field, root)
  if (!target) return false
  setDomValue(target, value)
  return true
}

/** Set a value on an element, dispatching input/change so frameworks update. */
export function setDomValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  if (el instanceof HTMLSelectElement) {
    // Try to match an option by text/value.
    const options = Array.from(el.options)
    const wanted = value.toLowerCase()
    const match =
      options.find((o) => o.value.toLowerCase() === wanted) ??
      options.find((o) => o.text.toLowerCase().includes(wanted))
    if (match) el.value = match.value
  } else {
    // Use the native setter so frameworks pick up the change.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) {
      setter.call(el, value)
    } else {
      el.value = value
    }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
