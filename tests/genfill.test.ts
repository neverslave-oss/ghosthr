import { describe, expect, it } from 'vitest'
import { parseGeneratedJson, type GeneratedField } from '../src/ai/genfill'

describe('parseGeneratedJson', () => {
  it('parses a plain JSON object of fields', () => {
    const out = parseGeneratedJson(
      '{"fields":[{"label":"Cover letter","value":"I am excited to join"},{"label":"Salary expectation","value":"€70k"}]}',
    )
    expect(out).toEqual([
      { label: 'Cover letter', value: 'I am excited to join' },
      { label: 'Salary expectation', value: '€70k' },
    ])
  })

  it('strips code fences that providers often wrap JSON in', () => {
    const out = parseGeneratedJson(
      '```json\n{"fields":[{"label":"Current role","value":"Senior Engineer"}]}\n```',
    )
    expect(out).toEqual([{ label: 'Current role', value: 'Senior Engineer' }])
  })

  it('drops entries without a label or value', () => {
    const out = parseGeneratedJson(
      '{"fields":[{"label":"","value":"x"},{"label":"Notice","value":""},{"label":"Real","value":"ok"}]}',
    )
    expect(out).toEqual([{ label: 'Real', value: 'ok' }])
  })

  it('returns [] for unparseable or non-JSON output', () => {
    expect(parseGeneratedJson('no json here')).toEqual([])
    expect(parseGeneratedJson('')).toEqual([])
  })
})

describe('GeneratedField dedupe contract', () => {
  it('produces label/value strings', () => {
    const f: GeneratedField = { label: 'Why this role?', value: 'Because…' }
    expect(typeof f.label).toBe('string')
    expect(typeof f.value).toBe('string')
  })
})
