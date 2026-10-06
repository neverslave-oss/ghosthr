// ghostHR deep-agent virtual filesystem (VFS).
//
// A small, sandboxed virtual workspace that persists under the Electron
// userData dir. Mirrors the docs' FilesystemBackend idea: the agent can list /
// read / write user-facing files (resume, cover letters, notes) without
// touching the real filesystem outside its root. Paths are normalized and must
// stay inside the root (blocks .., ~, absolute-outside-root).
const fs = require('node:fs')
const path = require('node:path')

class Vfs {
  /**
   * @param {string} root absolute root directory
   */
  constructor(root) {
    this.root = path.resolve(root)
  }

  /** Resolve a user-supplied path, throwing if it escapes the root. */
  _resolve(p) {
    const raw = String(p || '').replace(/\\/g, '/')
    const parts = raw.split('/')
    const stack = []
    for (const part of parts) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        // Climbing above root = attempted escape. Reject.
        if (stack.length === 0) throw new Error(`vfs path escapes root: ${p}`)
        stack.pop()
        continue
      }
      stack.push(part)
    }
    const abs = path.resolve(this.root, ...stack)
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`vfs path escapes root: ${p}`)
    }
    return abs
  }

  _ensureDir(abs) {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
  }

  list(p = '/') {
    const abs = this._resolve(p)
    let dir = abs
    try {
      if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir)
    } catch {
      dir = path.dirname(abs)
    }
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
        name: d.name,
        type: d.isDirectory() ? 'dir' : 'file',
        size: d.isFile() ? (fs.statSync(path.join(dir, d.name)).size ?? 0) : 0,
      }))
    } catch (e) {
      return `[vfs cannot list ${p}: ${e && e.message}]`
    }
    return JSON.stringify({ dir, entries }, null, 2)
  }

  read(p) {
    const abs = this._resolve(p)
    try {
      if (!fs.statSync(abs).isFile()) return { found: false, error: `${p} is a directory or missing` }
      const content = fs.readFileSync(abs, 'utf8')
      return { found: true, path: p, content }
    } catch (e) {
      return { found: false, error: `${e && e.message}` }
    }
  }

  write(p, content) {
    const abs = this._resolve(p)
    this._ensureDir(abs)
    fs.writeFileSync(abs, String(content ?? ''), 'utf8')
    return `[vfs wrote ${p}]`
  }
}

module.exports = { Vfs }
