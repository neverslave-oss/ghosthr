import { describe, expect, it } from 'vitest'
import { parseScanJson, localDetectedToScan, isOfflineScanSparse, type PageScan } from '../src/ai/scanner'

describe('isOfflineScanSparse', () => {
  const mk = (fields: number, description = 'Some job description text'): PageScan => ({
    jobTitle: '',
    company: '',
    jobDescription: description,
    fields: Array.from({ length: fields }, (_, i) => ({ label: `Field ${i}`, kind: 'input', required: true })),
  })

  it('is sparse when there are no fields', () => {
    expect(isOfflineScanSparse(mk(0))).toBe(true)
  })

  it('is sparse when null/undefined', () => {
    expect(isOfflineScanSparse(null)).toBe(true)
    expect(isOfflineScanSparse(undefined)).toBe(true)
  })

  it('is sparse when the offline pass recovered only a couple of fields', () => {
    expect(isOfflineScanSparse(mk(1))).toBe(true)
    expect(isOfflineScanSparse(mk(2))).toBe(true)
  })

  it('is sparse when there is no job description', () => {
    expect(isOfflineScanSparse(mk(6, ''))).toBe(true)
  })

  it('is sparse when the only fields are checkboxes (cookie-consent dialogs)', () => {
    const scan: PageScan = {
      jobTitle: '', company: '', jobDescription: 'Apply for this job',
      fields: Array.from({ length: 4 }, (_, i) => ({ label: `consent ${i}`, kind: 'checkbox' as const, required: false })),
    }
    expect(isOfflineScanSparse(scan)).toBe(true)
  })

  it('is NOT sparse with a solid field set + description', () => {
    expect(isOfflineScanSparse(mk(6))).toBe(false)
    expect(isOfflineScanSparse(localDetectedToScan({
      provider: 'workable',
      descriptionText: 'We are looking for a senior engineer.',
      fields: [
        { kind: 'input', label: 'First name', required: true },
        { kind: 'input', label: 'Last name', required: true },
        { kind: 'input', label: 'Email', required: true },
        { kind: 'input', label: 'Phone', required: true },
        { kind: 'input', label: 'LinkedIn', required: false },
        { kind: 'textarea', label: 'Cover letter', required: false },
      ],
    }))).toBe(false)
  })
})

describe('localDetectedToScan', () => {
  it('converts offline DOM detection into a PageScan (no LLM)', () => {
    const scan = localDetectedToScan({
      provider: 'workable',
      descriptionText: 'We are looking for a stellar engineer.',
      fields: [
        { kind: 'input', name: 'first_name', label: 'First name', required: true },
        { kind: 'input', name: 'email', label: 'Email', required: true },
        { kind: 'textarea', name: 'cover', label: 'Cover letter', required: false },
      ],
    })
    expect(scan.jobDescription).toContain('stellar engineer')
    expect(scan.fields).toHaveLength(3)
    expect(scan.fields[0].label).toBe('First name')
    expect(scan.fields[0].required).toBe(true)
    expect(scan.fields[2].kind).toBe('textarea')
  })

  it('falls back to name/placeholder for label and coerces kinds', () => {
    const scan = localDetectedToScan({
      provider: 'generic',
      descriptionText: '',
      fields: [
        { kind: 'SELECT', name: 'country' },
        { kind: 'checkbox', label: 'Agree', required: true },
      ],
    })
    expect(scan.fields[0].label).toBe('country')
    expect(scan.fields[0].kind).toBe('select')
    expect(scan.fields[1].kind).toBe('checkbox')
    expect(scan.fields[1].required).toBe(true)
  })
})

describe('parseScanJson', () => {
  it('parses a clean JSON response', () => {
    const scan = parseScanJson(
      JSON.stringify({
        jobTitle: 'Senior Engineer',
        company: 'Acme',
        jobDescription: 'We need TypeScript and React.',
        fields: [
          { label: 'First name', kind: 'input', required: true },
          { label: 'Email', kind: 'input', required: true },
          { label: 'Cover letter', kind: 'textarea', required: false },
        ],
      }),
    )
    expect(scan.jobTitle).toBe('Senior Engineer')
    expect(scan.company).toBe('Acme')
    expect(scan.fields).toHaveLength(3)
    expect(scan.fields[1].kind).toBe('input')
  })

  it('strips markdown code fences', () => {
    const scan = parseScanJson('```json\n{"jobTitle":"X","company":"Y","jobDescription":"d","fields":[]}\n```')
    expect(scan.jobTitle).toBe('X')
    expect(scan.fields).toEqual([])
  })

  it('extracts JSON embedded in prose', () => {
    const scan = parseScanJson('Here you go: {"jobTitle":"Dev","company":"C","jobDescription":"desc","fields":[{"label":"Email","kind":"input","required":true}]} hope that helps')
    expect(scan.jobTitle).toBe('Dev')
    expect(scan.fields[0].label).toBe('Email')
  })

  it('normalizes field kinds and coerces required', () => {
    const scan = parseScanJson(JSON.stringify({
      jobTitle: '',
      company: '',
      jobDescription: 'x',
      fields: [
        { label: 'A', kind: 'textarea', required: 'true' },
        { label: 'B', kind: 'SELECT', required: false },
      ],
    }))
    expect(scan.fields[0].kind).toBe('textarea')
    expect(scan.fields[0].required).toBe(true)
    expect(scan.fields[1].kind).toBe('select')
    expect(scan.fields[1].required).toBe(false)
  })

  it('tolerates missing label with a fallback', () => {
    const scan = parseScanJson(JSON.stringify({ jobTitle: '', company: '', jobDescription: 'x', fields: [{ kind: 'input', required: false }] }))
    expect(scan.fields[0].label).toMatch(/Field \d+/)
  })

  it('throws on non-object JSON', () => {
    expect(() => parseScanJson('not json at all')).toThrow()
  })
})
