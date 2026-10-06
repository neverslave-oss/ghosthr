/**
 * ghostHR local database layer (standalone).
 *
 * Uses SQLite via the sql.js-style WASM build. All data stays on the user's
 * machine. The schema holds: cv_profiles, applications, analyses, ghost_flags,
 * and a sync outbox (used later by the opt-in jobibot sync).
 */

import initSqlJs from 'sql.js'
import type { Database } from 'sql.js'

let db: Database | null = null

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

export interface Analysis {
  id: number
  application_id: number
  recommendation: string
  match_score: number
  payload_json: string
  created_at: string
}

export interface GhostFlag {
  id: number
  company: string
  ghost_risk: number // 0-100
  source: string
  noted_at: string
}

export interface OutboxEvent {
  id: number
  event_id: string
  kind: string
  payload_json: string
  status: string
  created_at: string
}

/** A single scanned job advertisement (result of a vision scan). */
export interface JobScan {
  id: number
  url: string
  title: string
  company: string
  description: string
  fields_json: string
  created_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cv_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  parsed_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  job_url TEXT,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  stage TEXT NOT NULL DEFAULT 'applied',
  notes TEXT,
  outcome TEXT
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  recommendation TEXT NOT NULL,
  match_score INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ghost_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  ghost_risk INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',
  noted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS job_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company);
CREATE INDEX IF NOT EXISTS idx_ghost_flags_company ON ghost_flags(company);
`

export async function openDb(): Promise<Database> {
  if (db) return db
  const SQL = await initSqlJs({
    locateFile: (f) => `https://sql.js.org/dist/${f}`,
  })
  db = new SQL.Database()
  db.exec(SCHEMA)
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

/** Insert a tracked application. Returns the new row id. */
export function addApplication(
  app: Omit<Application, 'id' | 'applied_at'> & { applied_at?: string },
): number {
  if (!db) throw new Error('db not open')
  db.run(
    `INSERT INTO applications (company, role, job_url, applied_at, stage, notes, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      app.company,
      app.role,
      app.job_url ?? null,
      app.applied_at ?? new Date().toISOString(),
      app.stage,
      app.notes ?? null,
      app.outcome ?? null,
    ],
  )
  return Number(db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0])
}

export function listApplications(): Application[] {
  if (!db) throw new Error('db not open')
  const res = db.exec('SELECT * FROM applications ORDER BY applied_at DESC')
  if (res.length === 0) return []
  const cols = res[0].columns
  return res[0].values.map((row) => {
    const obj: Record<string, unknown> = {}
    cols.forEach((c, i) => (obj[c] = row[i]))
    return obj as unknown as Application
  })
}

export function upsertCvProfile(name: string, rawText: string, parsedJson: string): number {
  if (!db) throw new Error('db not open')
  db.run(
    `INSERT INTO cv_profiles (name, raw_text, parsed_json) VALUES (?, ?, ?)`,
    [name, rawText, parsedJson],
  )
  return Number(db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0])
}

export function getLatestCvProfile(): CvProfile | null {
  if (!db) throw new Error('db not open')
  const res = db.exec('SELECT * FROM cv_profiles ORDER BY id DESC LIMIT 1')
  if (res.length === 0 || res[0].values.length === 0) return null
  const cols = res[0].columns
  const row = res[0].values[0]
  const obj: Record<string, unknown> = {}
  cols.forEach((c, i) => (obj[c] = row[i]))
  return obj as unknown as CvProfile
}

/** Persist a completed job scan. Returns the new row id. */
export function saveJobScan(scan: Omit<JobScan, 'id' | 'created_at'>): number {
  if (!db) throw new Error('db not open')
  db.run(
    `INSERT INTO job_scans (url, title, company, description, fields_json) VALUES (?, ?, ?, ?, ?)`,
    [scan.url, scan.title, scan.company, scan.description, scan.fields_json],
  )
  return Number(db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0])
}

export function listJobScans(): JobScan[] {
  if (!db) throw new Error('db not open')
  const res = db.exec('SELECT * FROM job_scans ORDER BY id DESC LIMIT 20')
  if (res.length === 0) return []
  const cols = res[0].columns
  return res[0].values.map((row) => {
    const obj: Record<string, unknown> = {}
    cols.forEach((c, i) => (obj[c] = row[i]))
    return obj as unknown as JobScan
  })
}
