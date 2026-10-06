import { describe, expect, it } from 'vitest'
import {
  buildDetectedForm,
  detectProvider,
  extractJobDescription,
  looksLikeApplicationForm,
  looksLikeJobAdvert,
  mapFieldName,
  normalizeText,
  type AthFormField,
} from '../src/content/ats'

const workableFields: AthFormField[] = [
  { kind: 'input', name: 'first_name', label: 'First name', placeholder: null, required: true },
  { kind: 'input', name: 'last_name', label: 'Last name', placeholder: null, required: true },
  { kind: 'input', name: 'email', label: 'Email', placeholder: null, required: true },
  { kind: 'textarea', name: 'cover_letter', label: 'Cover letter', placeholder: null, required: false },
]

describe('detectProvider', () => {
  it('detects workable from URL', () => {
    expect(detectProvider('https://apply.workable.com/boardofinnovation/j/531B141B6C/', '')).toBe('workable')
  })
  it('detects generic ATS from known vendors in url', () => {
    expect(detectProvider('https://boards.greenhouse.io/foo/jobs/123', '')).toBe('generic')
    expect(detectProvider('https://jobs.lever.co/acme/456', '')).toBe('generic')
  })
  it('falls back to generic otherwise', () => {
    expect(detectProvider('https://example.com/jobs/1', '')).toBe('generic')
  })
})

describe('looksLikeApplicationForm', () => {
  it('true when >2 text fields and job signal present', () => {
    expect(looksLikeApplicationForm(workableFields, 'Apply for this job position as a candidate.')).toBe(true)
  })
  it('false when too few fields', () => {
    const one: AthFormField[] = [{ kind: 'input', name: 'email', label: 'Email', placeholder: null, required: true }]
    expect(looksLikeApplicationForm(one, 'Apply for this job.')).toBe(false)
  })
})

describe('extractJobDescription', () => {
  it('returns the longest paragraph before the first field index', () => {
    const body = 'We are hiring a senior engineer with lots of detail here. ' +
      '\nFirst name\nLast name'
    const firstIdx = body.indexOf('First name')
    const desc = extractJobDescription(body, firstIdx)
    expect(desc).toContain('senior engineer')
    expect(desc).not.toContain('First name')
  })
})

describe('mapFieldName', () => {
  it('maps common labels to canonical fields', () => {
    expect(mapFieldName('Email', null)).toBe('email')
    expect(mapFieldName('First name', null)).toBe('first_name')
    expect(mapFieldName(null, 'LinkedIn URL')).toBe('linkedin_url')
    expect(mapFieldName('Cover letter', null)).toBe('cover_letter')
    expect(mapFieldName(null, 'Phone number')).toBe('phone')
  })
  it('returns null for unknown', () => {
    expect(mapFieldName('Favorite color', null)).toBeNull()
    expect(mapFieldName(null, null)).toBeNull()
  })
})

describe('buildDetectedForm', () => {
  it('assembles provider, description, fields, applyUrl', () => {
    const form = buildDetectedForm({
      url: 'https://apply.workable.com/acme/j/A1/',
      bodyText: 'Job description here with many details. ' + '\nFirst name\nLast name',
      fields: workableFields,
      firstFieldIndex: 20,
      applyUrl: 'https://apply.workable.com/acme/j/A1/apply/',
    })
    expect(form.provider).toBe('workable')
    expect(form.fields.length).toBe(4)
    expect(form.descriptionText.length).toBeGreaterThan(0)
    expect(form.applyUrl).toContain('/apply/')
  })
})

describe('looksLikeJobAdvert', () => {
  it('true for job-overview/description text', () => {
    expect(looksLikeJobAdvert('Senior ML Engineer - Remote. We are looking for a stellar candidate.')).toBe(true)
    expect(looksLikeJobAdvert('Apply for this job • About the role • Requirements')).toBe(true)
  })
  it('false for unrelated text', () => {
    expect(looksLikeJobAdvert('Cookies policy and privacy notice.')).toBe(false)
  })
})

describe('normalizeText', () => {
  it('collapses whitespace', () => {
    expect(normalizeText('  a   b \n  c ')).toBe('a b c')
    expect(normalizeText(null)).toBe('')
    expect(normalizeText(undefined)).toBe('')
  })
})
