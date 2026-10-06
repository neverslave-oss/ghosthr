import { describe, expect, it } from 'vitest'
import { analyze, type ParsedCv } from '../src/ai/verdict'

const strongCv: ParsedCv = {
  skills: ['typescript', 'react', 'node', 'postgres', 'docker', 'aws', 'python', 'machine learning'],
  years_experience: 5,
  projects: ['built a SaaS platform'],
}

const weakCv: ParsedCv = {
  skills: ['marketing', 'seo'],
  years_experience: 1,
}

describe('analyze — recommendation', () => {
  it('apply_now when skills overlap strongly and no ghost signals', () => {
    const v = analyze({
      jobText:
        'Senior Full-Stack Engineer. We need TypeScript, React, Node, PostgreSQL, Docker, AWS. ' +
        '5+ years building production web applications. Join our platform team.',
      cv: strongCv,
    })
    expect(v.recommendation).toBe('apply_now')
    expect(v.match_score).toBeGreaterThanOrEqual(70)
  })

  it('hold_back when candidate is weakly matched', () => {
    const v = analyze({
      jobText:
        'Senior Full-Stack Engineer requiring TypeScript, React, Node, Postgres, Docker, AWS.',
      cv: weakCv,
    })
    expect(v.recommendation).toBe('hold_back')
    expect(v.match_score).toBeLessThan(60)
  })

  it('hold_back when many ghost-job signals present', () => {
    const v = analyze({
      jobText:
        'Immediate start. Unlimited earning, uncapped commission, work from anywhere, ' +
        'no experience necessary, urgent hire, fastest growing company. Just a quick note ' +
        'we will train you, no phone calls please.',
      cv: strongCv,
    })
    expect(v.recommendation).toBe('hold_back')
    expect(v.red_flags.length).toBeGreaterThanOrEqual(3)
  })

  it('produces hold-back actions with effort estimates', () => {
    const v = analyze({
      jobText: 'Needs TypeScript, React, Node, AWS, Docker, Kubernetes, Terraform, Go.',
      cv: weakCv,
    })
    expect(Array.isArray(v.hold_back_actions)).toBe(true)
    expect(v.hold_back_actions.length).toBeGreaterThan(0)
    for (const a of v.hold_back_actions) {
      expect(a.est_effort_days).toBeGreaterThanOrEqual(0)
      expect(a.est_effort_days).toBeLessThanOrEqual(14)
      expect(['build', 'study', 'portfolio', 'network', 'reframe']).toContain(a.action)
    }
  })

  it('score breakdown is bounded 0-100', () => {
    const v = analyze({ jobText: 'A real job with enough detail ' + 'word '.repeat(60), cv: strongCv })
    const s = v.score_breakdown
    for (const k of ['skills', 'experience', 'fit_signal']) {
      expect(s[k as keyof typeof s]).toBeGreaterThanOrEqual(0)
      expect(s[k as keyof typeof s]).toBeLessThanOrEqual(100)
    }
  })

  it('always returns a structured verdict even with minimal cv', () => {
    const v = analyze({ jobText: 'Some listing text.', cv: { skills: [] } })
    expect(v).toHaveProperty('recommendation')
    expect(v).toHaveProperty('match_score')
    expect(v).toHaveProperty('gap_analysis')
    expect(v).toHaveProperty('hold_back_actions')
    expect(v).toHaveProperty('red_flags')
  })
})
