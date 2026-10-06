import { describe, expect, it } from 'vitest'
import { cvValueBag, resolveFieldValue } from '../src/content/autofill'
import type { ParsedCv } from '../src/ai/verdict'
import type { ScannedField } from '../src/ai/scanner'

const cv: ParsedCv = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+4912345678',
  skills: ['typescript', 'react'],
  years_experience: 5,
  raw_text: 'Jane Doe — Full-stack engineer. https://linkedin.com/in/janedoe linkedin.com profile. https://github.com/jane',
  projects: [],
}

describe('cvValueBag', () => {
  it('splits name into first/last', () => {
    const bag = cvValueBag(cv)
    expect(bag.first_name).toBe('Jane')
    expect(bag.last_name).toBe('Doe')
  })
  it('extracts email and phone', () => {
    const bag = cvValueBag(cv)
    expect(bag.email).toBe('jane@example.com')
    expect(bag.phone).toBe('+4912345678')
  })
  it('extracts linkedin url', () => {
    const bag = cvValueBag(cv)
    expect(bag.linkedin_url).toMatch(/linkedin\.com/)
  })
  it('handles missing name', () => {
    const bag = cvValueBag({ ...cv, name: undefined })
    expect(bag.first_name).toBeUndefined()
  })
})

describe('resolveFieldValue', () => {
  const bag = cvValueBag(cv)
  const mk = (label: string): ScannedField => ({ label, kind: 'input', required: false })

  it('maps email field', () => {
    expect(resolveFieldValue(mk('Email'), bag)).toBe('jane@example.com')
  })
  it('maps first/last name', () => {
    expect(resolveFieldValue(mk('First name'), bag)).toBe('Jane')
    expect(resolveFieldValue(mk('Last name'), bag)).toBe('Doe')
  })
  it('maps linkedin and phone', () => {
    expect(resolveFieldValue(mk('LinkedIn URL'), bag)).toMatch(/linkedin/)
    expect(resolveFieldValue(mk('Phone number'), bag)).toBe('+4912345678')
  })
  it('returns undefined for unmapped/unknown fields', () => {
    expect(resolveFieldValue(mk('Salary expectation'), bag)).toBeUndefined()
    expect(resolveFieldValue(mk(''), bag)).toBeUndefined()
  })
})
