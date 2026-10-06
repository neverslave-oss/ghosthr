// ghostHR deep-agent live web research.
//
// Key-free provider-agnostic web search so the agent can ground coaching in
// current employer/role info without a Tavily key or a provider search token.
// Uses DuckDuckGo's Instant Answer (zero-config, no key). Fails gracefully —
// the tool contract expects a string even on error.

/**
 * @param {string} query
 * @returns {Promise<string>} text result (or a short graceful error string)
 */
async function webSearch(query) {
  const q = String(query || '').trim()
  if (!q) return '[web_search: empty query]'
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 8000)
    const url =
      'https://api.duckduckgo.com/?q=' +
      encodeURIComponent(q) +
      '&format=json&no_html=1&skip_disambig=1'
    const res = await fetch(url, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return `[web_search: http ${res.status}]`
    const data = await res.json()
    const lines = []
    if (data?.AbstractText) lines.push(data.AbstractText)
    if (data?.AbstractURL) lines.push('Source: ' + data.AbstractURL)
    const top =
      (data?.RelatedTopics || []).filter((r) => typeof r.Text === 'string' && r.FirstURL).slice(0, 5)
    for (const r of top) lines.push('• ' + r.Text + ' — ' + r.FirstURL)
    return lines.length ? lines.join('\n') : `[web_search: no instant answers for "${q}". Search a more specific employer/role term.]`
  } catch (e) {
    return `[web_search unavailable: ${e && e.message}]`
  }
}

module.exports = { webSearch }
