import { describe, expect, it } from 'vitest'
import { parseScanJson, type PageScan } from '../src/ai/scanner'

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
