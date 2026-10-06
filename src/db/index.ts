/**
 * ghostHR local data store (standalone).
 *
 * Persists via chrome.storage.local — the MV3-sanctioned key/value store —
 * instead of sql.js WASM. Reason: sql.js tries to load its WASM binary over
 * XMLHttpRequest and to instantiate it with `wasm-eval`, neither of which works
 * under an MV3 service worker's default CSP (Issue #1). chrome.storage avoids
 * WASM/XHR entirely and is fully supported in MV3.
 *
 * Collections are JSON-serialized arrays. Everything stays on the user's
 * machine. Schema mirrors the Phase 1 design:
 *   applications[], cv_profiles[], job_scans[] (+ analyses/ghost_flags/outbox
 *   reserved for later).
 */

export interface CvProfile {
  id: number
  name: string
  raw_text: string
  parsed_json: string
  created_at: string
}

export interface Application {
  id: number
  company: string
  role: string
  job_url: string | null
  applied_at: string
  stage: string
  notes: string | null
  outcome: string | null
}

export interface JobScan {
  id: number
  url: string
  title: string
  company: string
  description: string
  fields_json: string
  created_at: string
}

const K = {
  applications: 'ghosthr.applications',
  cvProfiles: 'ghosthr.cv_profiles',
  jobScans: 'ghosthr.job_scans',
  currentScan: 'ghosthr.current_scan',
  seq: 'ghosthr.seq',
}

async function readArr<T>(key: string): Promise<T[]> {
  const got = await chrome.storage.local.get(key)
  const v = got[key]
  return Array.isArray(v) ? (v as T[]) : []
}

async function writeArr<T>(key: string, arr: T[]): Promise<void> {
  await chrome.storage.local.set({ [key]: arr })
}

async function nextId(): Promise<number> {
  const got = await chrome.storage.local.get(K.seq)
  const n = (typeof got[K.seq] === 'number' ? (got[K.seq] as number) : 0) + 1
  await chrome.storage.local.set({ [K.seq]: n })
  return n
}

/** Storage needs no explicit init — kept as the open hook. */
export async function openDb(): Promise<void> {
  return
}

export async function closeDb(): Promise<void> {
  return
}

/** Insert a tracked application. Returns the new row id. */
export async function addApplication(
  app: Omit<Application, 'id' | 'applied_at'> & { applied_at?: string },
): Promise<number> {
  const arr = await readArr<Application>(K.applications)
  const id = await nextId()
  arr.push({
    id,
    company: app.company,
    role: app.role,
    job_url: app.job_url ?? null,
    applied_at: app.applied_at ?? new Date().toISOString(),
    stage: app.stage,
    notes: app.notes ?? null,
    outcome: app.outcome ?? null,
  })
  await writeArr(K.applications, arr)
  return id
}

export async function listApplications(): Promise<Application[]> {
  const arr = await readArr<Application>(K.applications)
  return arr.slice().sort((a, b) => (a.applied_at < b.applied_at ? 1 : -1))
}

export async function upsertCvProfile(name: string, rawText: string, parsedJson: string): Promise<number> {
  const arr = await readArr<CvProfile>(K.cvProfiles)
  const id = await nextId()
  arr.push({
    id,
    name,
    raw_text: rawText,
    parsed_json: parsedJson,
    created_at: new Date().toISOString(),
  })
  await writeArr(K.cvProfiles, arr)
  return id
}

export async function getLatestCvProfile(): Promise<CvProfile | null> {
  const arr = await readArr<CvProfile>(K.cvProfiles)
  return arr.length ? arr[arr.length - 1] : null
}

/** Persist a completed job scan. Returns the new row id. */
export async function saveJobScan(
  scan: Omit<JobScan, 'id' | 'created_at'>,
): Promise<number> {
  const arr = await readArr<JobScan>(K.jobScans)
  const id = await nextId()
  arr.push({
    id,
    url: scan.url,
    title: scan.title,
    company: scan.company,
    description: scan.description,
    fields_json: scan.fields_json,
    created_at: new Date().toISOString(),
  })
  await writeArr(K.jobScans, arr)
  return id
}

export async function listJobScans(): Promise<JobScan[]> {
  const arr = await readArr<JobScan>(K.jobScans)
  return arr.slice().reverse()
}

/** Persist the currently-active scan so it survives a popup close/reopen. */
export async function saveCurrentScan(scan: unknown): Promise<void> {
  await chrome.storage.local.set({ [K.currentScan]: scan })
}

/** Read back the persisted current scan (or null). */
export async function getCurrentScan(): Promise<unknown> {
  const got = await chrome.storage.local.get(K.currentScan)
  return got?.[K.currentScan] ?? null
}
