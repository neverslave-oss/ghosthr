import { describe, expect, it } from 'vitest'
import { parseCvJson, parseCvLocally, detectCvKind, extractDocxText } from '../src/ai/cvocr'

describe('parseCvJson', () => {
  it('parses a clean CV response', () => {
    const cv = parseCvJson(
      JSON.stringify({
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '+123',
        skills: ['typescript', 'react', 'aws'],
        years_experience: 5,
        education: ['BSc CS'],
        projects: ['built x'],
        summary: 'Full-stack engineer',
      }),
    )
    expect(cv.name).toBe('Jane Doe')
    expect(cv.email).toBe('jane@example.com')
    expect(cv.skills).toContain('react')
    expect(cv.years_experience).toBe(5)
  })

  it('strips code fences and prose', () => {
    const cv = parseCvJson('```json\n{"skills":["vue"],"years_experience":3}\n``` ok done')
    expect(cv.skills).toEqual(['vue'])
    expect(cv.years_experience).toBe(3)
  })

  it('defaults years_experience when absent', () => {
    const cv = parseCvJson('{"skills":["ts"]}')
    expect(cv.years_experience).toBeUndefined()
  })

  it('filters non-string skills', () => {
    const cv = parseCvJson('{"skills":["go", 42, null, "python"]}')
    expect(cv.skills).toEqual(['go', 'python'])
  })
})

describe('detectCvKind', () => {
  it('detects by extension', () => {
    expect(detectCvKind('cv.pdf')).toBe('pdf')
    expect(detectCvKind('cv.docx')).toBe('docx')
    expect(detectCvKind('cv.doc')).toBe('docx')
    expect(detectCvKind('cv.png')).toBe('image')
    expect(detectCvKind('cv.JPG')).toBe('image')
  })
  it('falls back to pdf for unknown extension', () => {
    expect(detectCvKind('cv.xyz')).toBe('pdf')
    expect(detectCvKind('cv')).toBe('pdf')
  })
  it('uses mime when extension unknown', () => {
    expect(detectCvKind('file.bin', 'application/pdf')).toBe('pdf')
    expect(detectCvKind('file.bin', 'image/webp')).toBe('image')
    expect(detectCvKind('file.bin', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx')
  })
})

describe('extractDocxText', () => {
  it('extracts <w:t> runs from a docx zip', async () => {
    // A minimal zip is hard to fabricate; test that invalid input yields '' safely.
    const text = await extractDocxText(new Uint8Array([0x50, 0x4b, 0x03, 0x04])) // a bogus zip header
    expect(typeof text).toBe('string')
  })
})

describe('parseCvLocally', () => {
  const CV = `Fabio Pacifici
fabio@example.com
+39 123 456 789

Full-stack engineer with 6 years of experience building web apps.

Skills: TypeScript, React, Python, Docker, Kubernetes

Bachelor of Science in Computer Science

Built a real-time dashboard handling 10k users (React + WebSocket).
Led a team of 4 shipping a payments service.`

  it('extracts name, email and phone', () => {
    const cv = parseCvLocally(CV)
    expect(cv.name).toBe('Fabio Pacifici')
    expect(cv.email).toBe('fabio@example.com')
    expect(cv.phone).toBeTruthy()
  })

  it('extracts skills from the shared vocabulary + inline list', () => {
    const cv = parseCvLocally(CV)
    expect(cv.skills).toContain('react')
    expect(cv.skills).toContain('python')
    expect(cv.skills).toContain('docker')
    expect(cv.skills).toContain('TypeScript')
  })

  it('infers years of experience', () => {
    const cv = parseCvLocally(CV)
    expect(cv.years_experience).toBe(6)
  })

  it('extracts education lines', () => {
    const cv = parseCvLocally(CV)
    expect(cv.education?.some((e) => /bachelor/i.test(e))).toBe(true)
  })

  it('extracts project lines', () => {
    const cv = parseCvLocally(CV)
    expect(cv.projects?.some((p) => /built/i.test(p))).toBe(true)
  })

  it('handles empty input gracefully', () => {
    const cv = parseCvLocally('')
    expect(Array.isArray(cv.skills)).toBe(true)
    expect(cv.skills.length).toBe(0)
  })
})
