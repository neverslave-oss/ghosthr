/**
 * ghostHR verdict engine — the "hold back" decision.
 *
 * Pure, deterministic, and unit-testable. It turns a job listing + a parsed CV
 * into a structured verdict: recommendation, match score, gap analysis, and
 * specific hold-back actions with effort estimates.
 *
 * This is the coaching layer that differentiates ghostHR from a keyword-match
 * tool. Provider routing (local-first -> HF -> doubleword -> openrouter) is a
 * separate concern; this module owns the shaping + local heuristic baseline so
 * the UI works standalone even before any provider call.
 */

export type Recommendation = 'apply_now' | 'apply_with_caveats' | 'hold_back'

export interface HoldBackAction {
  action: 'build' | 'study' | 'portfolio' | 'network' | 'reframe'
  detail: string
  est_effort_days: number // 0-14
}

export interface Verdict {
  recommendation: Recommendation
  match_score: number // 0-100
  score_breakdown: { skills: number; experience: number; fit_signal: number }
  gap_analysis: string[]
  hold_back_actions: HoldBackAction[]
  red_flags: string[]
  reasoning: string
}

export interface ParsedCv {
  name?: string
  email?: string
  phone?: string
  skills: string[]
  years_experience?: number
  education?: string[]
  projects?: string[]
  raw_text?: string
}

/** Ghost-job signals commonly seen in low-quality / reposted listings. */
const GHOST_SIGNALS = [
  'immediate start',
  'unlimited earning',
  'no experience necessary',
  'entry level',
  'urgent hire',
  'fastest growing',
  'work from anywhere',
  'uncapped commission',
  'we will train',
  'no phone calls please',
]

export const COMMON_SKILLS = [
  'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c++', 'c#',
  'react', 'vue', 'angular', 'node', 'sql', 'postgres', 'mysql', 'mongodb',
  'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'ci/cd', 'terraform',
  'machine learning', 'ai', 'llm', 'data analysis', 'excel', 'communication',
  'project management', 'agile', 'figma', 'marketing', 'sales', 'seo',
]

export interface AnalyzeInput {
  jobText: string
  cv: ParsedCv
}

/** Tokenize text to lowercase words for crude skill overlap detection. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((t) => t.replace(/[.#]$/, ''))
}

/** Detect which of the candidate's skills appear in the job text. */
function skillOverlap(jobText: string, cvSkills: string[]): { present: string[]; missing: string[] } {
  const jobTokens = new Set(tokenize(jobText))
  const present: string[] = []
  const missing: string[] = []
  for (const skill of cvSkills) {
    const key = skill.toLowerCase().trim()
    const matched =
      jobTokens.has(key) ||
      COMMON_SKILLS.some((s) => key.includes(s) && jobText.toLowerCase().includes(s))
    if (matched) present.push(skill)
    else missing.push(skill)
  }
  return { present, missing }
}

/** Detect ghost-job signals present in the listing text. */
function detectRedFlags(jobText: string): string[] {
  const lower = jobText.toLowerCase()
  return GHOST_SIGNALS.filter((s) => lower.includes(s))
}

/** Which known skills the job listing actually asks for. */
function jobRequiredSkills(jobText: string): string[] {
  const lower = jobText.toLowerCase()
  return COMMON_SKILLS.filter((s) => lower.includes(s))
}

/**
 * Job-required skills the candidate does NOT list — the real, concrete gap.
 * Uses the full skill name (so "React" isn't a false gap just because the CV
 * says "React Native", and "machine learning" matches a "ML"-style subset).
 */
function missingRequiredSkills(jobText: string, cvSkills: string[]): string[] {
  const cvNorm = cvSkills.map((s) => s.toLowerCase().trim())
  return jobRequiredSkills(jobText).filter((s) => {
    // Covered if the CV lists it directly or embeds it in a broader skill.
    return !cvNorm.some((k) => k === s || k.includes(s) || s.includes(k))
  })
}

/**
 * Produce a verdict from a job + CV. Pure function, no I/O.
 */
export function analyze(input: AnalyzeInput): Verdict {
  const jobTokens = new Set(tokenize(input.jobText))
  const hasJobDetails = jobTokens.size > 40

  // Skills score: fraction of candidate skills found in the listing.
  const { present } = skillOverlap(input.jobText, input.cv.skills)
  const skillsScore = input.cv.skills.length
    ? Math.round((present.length / input.cv.skills.length) * 100)
    : 50

  // Experience score: if years known and listing mentions a seniority band.
  const expScore = computeExperienceScore(input.jobText, input.cv.years_experience)

  // Fit signal: weighted composite of job-detail richness and skills.
  const fitSignal = hasJobDetails ? Math.round(skillsScore * 0.7 + expScore * 0.3) : skillsScore

  const redFlags = detectRedFlags(input.jobText)
  const matchScore = Math.round(skillsScore * 0.6 + expScore * 0.25 + fitSignal * 0.15)

  const gap = buildGapAnalysis(input.cv)
  const missingSkills = missingRequiredSkills(input.jobText, input.cv.skills)
  const actions = buildHoldBackActions(input.jobText, input.cv, skillsScore, gap, missingSkills)

  let recommendation: Recommendation
  if (redFlags.length >= 3) {
    recommendation = 'hold_back'
  } else if (skillsScore >= 70 && redFlags.length === 0 && fitSignal >= 60) {
    recommendation = 'apply_now'
  } else if (skillsScore >= 45) {
    recommendation = 'apply_with_caveats'
  } else {
    recommendation = 'hold_back'
  }

  const reasoning = [
    `Skills overlap: ${present.length}/${input.cv.skills.length} (${skillsScore}%).`,
    missingSkills.length
      ? `Missing for this role: ${missingSkills.slice(0, 5).join(', ')}.`
      : '',
    redFlags.length
      ? `Detected ${redFlags.length} ghost-job signal(s).`
      : 'No clear ghost-job signals in listing.',
  ].filter(Boolean).join(' ')

  return {
    recommendation,
    match_score: matchScore,
    score_breakdown: { skills: skillsScore, experience: expScore, fit_signal: fitSignal },
    gap_analysis: gap,
    hold_back_actions: actions,
    red_flags: redFlags,
    reasoning,
  }
}

function computeExperienceScore(jobText: string, years?: number): number {
  if (years === undefined || years === null) return 60
  // Look for explicit seniority bands in the listing (e.g. "5+ years").
  const m = jobText.toLowerCase().match(/(\d+)\s*\+?\s*\+?\s*years?\b/)
  if (m) {
    const required = Number(m[1])
    return years >= required ? 90 : Math.max(20, 100 - (required - years) * 20)
  }
  if (jobText.toLowerCase().includes('junior') && years < 2) return 90
  if (jobText.toLowerCase().includes('senior') && years >= 5) return 90
  return years >= 3 ? 75 : 55
}

function buildGapAnalysis(cv: ParsedCv): string[] {
  const gaps: string[] = []
  if (!cv.skills.length) gaps.push('No skills captured on CV — add them for a reliable scan.')
  if (!cv.years_experience && cv.years_experience !== 0) {
    gaps.push('Years of experience unknown — this lowers match confidence.')
  }
  if (!cv.projects?.length && !cv.raw_text) {
    gaps.push('No projects or raw CV text — evidence for fit is thin.')
  }
  return gaps
}

function buildHoldBackActions(
  jobText: string,
  cv: ParsedCv,
  skillsScore: number,
  gaps: string[],
  missingSkills: string[],
): HoldBackAction[] {
  const actions: HoldBackAction[] = []
  if (skillsScore < 70) {
    // Data-driven: point at the ACTUAL skills the job asks for that the CV
    // lacks (jobRequiredSkills ∩ ~CV). Effort scales with how many are missing.
    const targets = missingSkills.length
      ? missingSkills.slice(0, 3).join(', ')
      : cv.skills.join(', ') || 'core'
    const effort = missingSkills.length >= 3 ? 10 : missingSkills.length === 2 ? 6 : 4
    actions.push({
      action: 'study',
      detail: missingSkills.length
        ? `The role emphasizes ${targets} — not on your CV yet. Plan focused work to close at least the top gap before applying.`
        : `Strengthen ${targets} skills that the role emphasizes before applying.`,
      est_effort_days: effort,
    })
  }
  if (!cv.projects?.length) {
    actions.push({
      action: 'portfolio',
      detail: 'Add 1-2 concrete projects that demonstrate the skills in the job description.',
      est_effort_days: 5,
    })
  }
  if (gaps.some((g) => g.includes('years'))) {
    actions.push({
      action: 'reframe',
      detail: 'Reframe your CV to emphasize results and years of relevant work even if title history is mixed.',
      est_effort_days: 1,
    })
  }
  if (actions.length === 0) {
    actions.push({
      action: 'network',
      detail: 'Find 1-2 people at the company to learn about the team before applying.',
      est_effort_days: 2,
    })
  }
  return actions
}
