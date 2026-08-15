// Web tools: webfetch (GET + HTML-to-text), websearch (multi-engine fallback
// with retry + 1h disk cache), and structured JSON-API searches that are far
// more reliable than HTML scraping:
//   search_repos     — GitHub repository search (what tools/frameworks exist)
//   search_packages  — npm registry search (installable modules)
//   search_news      — Hacker News Algolia search (fresh ideas/trends)
//   rss_fetch        — parse any RSS/Atom feed (monitor known blogs/feeds)

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_DIR = path.join(os.homedir(), '.voidcode', 'cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const UA = 'VoidCode/0.1 (research agent) Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------- disk cache ----------------

function cacheKey(kind, ...parts) {
  const sanitized = parts
    .map((p) => String(p).toLowerCase().replace(/[^a-z0-9]+/gi, '_').replace(/_+/g, '_').slice(0, 80))
    .join('_');
  return `${kind}_${sanitized}`;
}

function cacheGet(key) {
  try {
    const file = path.join(CACHE_DIR, key + '.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !data.ts || Date.now() - data.ts > CACHE_TTL_MS) return null;
    return data.body;
  } catch { return null; }
}

function cacheSet(key, body) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify({ ts: Date.now(), body }), 'utf8');
  } catch { /* cache is best-effort */ }
}

// ---------------- fetch helpers ----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransient(err) {
  const m = String(err?.message || '');
  return /fetch failed|stalled|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|network|HTTP (408|429|5\d\d)/i.test(m);
}

async function fetchRetry(url, opts = {}, { retries = 2, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < retries) await sleep(1200 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      if (attempt < retries) await sleep(900 * (attempt + 1));
    }
  }
  throw lastErr || new Error('request failed');
}

// ---------------- HTML to text ----------------

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// ---------------- search-engine parsers (HTML scraping) ----------------

function parseDDG(html) {
  const results = [];
  const titleRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const titles = [];
  let m;
  while ((m = titleRegex.exec(html)) !== null) {
    let link = m[1];
    if (link.includes('uddg=')) {
      const um = link.match(/[?&]uddg=([^&]+)/);
      if (um) link = decodeURIComponent(um[1]);
    }
    if (link.startsWith('//')) link = 'https:' + link;
    titles.push({ url: link, title: m[2].replace(/<[^>]+>/g, '').trim(), index: m.index });
  }

  const snippets = [];
  while ((m = snippetRegex.exec(html)) !== null) {
    snippets.push({ text: m[1].replace(/<[^>]+>/g, '').trim(), index: m.index });
  }

  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    const nextTitleIdx = (i + 1 < titles.length) ? titles[i + 1].index : html.length;
    const s = snippets.find((sn) => sn.index > t.index && sn.index < nextTitleIdx);
    if (t.url.includes('duckduckgo.com/y.js') || t.url.includes('ad_provider')) continue;
    results.push({ title: t.title, url: t.url, snippet: s ? s.text : '' });
    if (results.length >= 10) break;
  }
  return results;
}

function decodeBingRedirect(url) {
  if (!/^(https?:\/\/www\.bing\.com\/ck\/a)/i.test(url)) return url;
  const clean = url.split('&amp;').join('&');
  const m = clean.match(/[?&]u=a1([A-Za-z0-9+/=_-]+)/);
  if (!m) return url;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {}
  return url;
}

function parseBing(html) {
  const results = [];
  const liRegex = /<li\s+class="b_algo"[\s\S]*?<\/li>/gi;
  let block;
  while ((block = liRegex.exec(html)) !== null) {
    const li = block[0];
    const a = li.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a || !/^https?:\/\//i.test(a[1])) continue;
    const url = decodeBingRedirect(a[1]);
    const title = a[2].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    const snap = li.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snap ? snap[1].replace(/<[^>]+>/g, '').trim() : '';
    results.push({ title, url, snippet });
    if (results.length >= 10) break;
  }
  return results;
}

function parseMojeek(html) {
  const results = [];
  const liRegex = /<li[\s\S]*?<\/li>/gi;
  let block;
  while ((block = liRegex.exec(html)) !== null) {
    const li = block[0];
    const a = li.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = a[1];
    const title = a[2].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    // Skip nav/logo/home links (short titles, no snippet block)
    if (!/<p[^>]*>[\s\S]*?<\/p>/i.test(li) && title.length > 100) continue;
    const snap = li.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snap ? snap[1].replace(/<[^>]+>/g, '').trim() : '';
    results.push({ title, url, snippet });
    if (results.length >= 10) break;
  }
  return results;
}

function formatSearchResults(results, query, engine) {
  let out = `Search Results for "${query}" (via ${engine}):\n\n`;
  results.slice(0, 8).forEach((r, idx) => {
    out += `${idx + 1}. **${r.title}**\n`;
    out += `   URL: ${r.url}\n`;
    if (r.snippet) out += `   Snippet: ${r.snippet}\n`;
  });
  return out;
}

// ---------------- RSS / Atom parser ----------------

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[0];
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]) : '';
    // RSS 2.0: <link>URL</link>  Atom: <link href="URL"/>
    let url = '';
    const atomLink = block.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/i) ||
                    block.match(/<link[^>]+href="([^"]+)"[^>]*>/i);
    if (atomLink) url = atomLink[1];
    else {
      const rssLink = block.match(/<link[^>]*>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/link>/i) ||
                      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      if (rssLink) url = htmlToText(rssLink[1]).trim();
    }
    if (!title && !url) continue;
    items.push({ title: title.slice(0, 300), url: url.startsWith('http') ? url : '' });
    if (items.length >= 20) break;
  }
  return items.filter((i) => i.title || i.url);
}

// ---------------- tool definitions ----------------

const defs = [
  {
    name: 'webfetch',
    description: 'Fetch a URL (HTTP GET). HTML is converted to readable text; other content returned raw (truncated).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        raw: { type: 'boolean', description: 'return raw body without HTML stripping' },
      },
      required: ['url'],
    },
  },
  {
    name: 'websearch',
    description: 'Search the web for a query. Tries DuckDuckGo, then Bing, then Mojeek (automatic fallback) with retries and 1h caching, returning titles, links, and snippets of the top results. For code/tools/packages use search_repos or search_packages; for fresh discussions/ideas use search_news.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search term or query' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_repos',
    description: 'Search GitHub repositories for real-world code, tools, frameworks, and libraries. Returns full name, stars, language, description, and URL. Best source for "is there a tool/module for X" and discovering what people are building. Free API (roughly 10 searches/min, cached 1h).',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'GitHub search query, e.g. "mcp server code review" or "topic:trading language:typescript"' }
      },
      required: ['q']
    }
  },
  {
    name: 'search_packages',
    description: 'Search the npm registry for JavaScript/Node packages. Returns package name, version, description, and links. Best for finding an installable module that provides some capability.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'npm search query, e.g. "markdown table editor"' }
      },
      required: ['q']
    }
  },
  {
    name: 'search_news',
    description: 'Search Hacker News stories (via the Algolia API). Returns story title, points, comment count, author, and URL. Best for fresh ideas, and finding what people are currently making and discussing.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query, e.g. "new agent tool framework"' }
      },
      required: ['q']
    }
  },
  {
    name: 'rss_fetch',
    description: 'Fetch and parse an RSS or Atom feed URL into recent item titles and links. Use to monitor a known blog, news site, changelog, or release feed.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the RSS/Atom feed' },
        limit: { type: 'number', description: 'max items to return (default 10)' }
      },
      required: ['url']
    }
  },
  {
    name: 'tavily_search',
    description: 'Search the web via the Tavily API (requires a configured Tavily API key). More reliable than websearch since it is a real API, not HTML scraping, and can include an AI-generated answer summary plus optional page content. Best default choice for general web search when a key is configured.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        maxResults: { type: 'number', description: 'max results to return (default 5, max 20)' },
        searchDepth: { type: 'string', enum: ['basic', 'advanced'], description: 'basic (default, fast) or advanced (deeper, slower, costs more credits)' },
        includeAnswer: { type: 'boolean', description: 'include an AI-generated short answer summary (default true)' },
      },
      required: ['query']
    }
  },
];

// ---------------- executors ----------------

function makeExecutors(ctx) {
  const logFetch = (url, statusText, body) => {
    // Automatic Audit Log Writing for Focus Sessions
    if (ctx && ctx.focusSession && ctx.cwd) {
      const logPath = path.join(ctx.cwd, 'research_audit_log.md');
      const timestamp = new Date().toLocaleString();
      let logContent = '';
      if (!fs.existsSync(logPath)) {
        logContent += `# Research Audit Log\n\n`;
        logContent += `*   **Session ID:** ${ctx.focusSession.id}\n`;
        logContent += `*   **Description:** ${ctx.focusSession.description}\n`;
        logContent += `*   **Started:** ${new Date(ctx.focusSession.createdAt).toLocaleString()}\n\n`;
        logContent += `## Visited Websites\n\n`;
      }
      logContent += `### Visit: ${url}\n`;
      logContent += `*   **Time:** ${timestamp}\n`;
      logContent += `*   **Status:** ${statusText}\n`;
      logContent += `*   **Initial Snippet:** ${body ? body.slice(0, 300).replace(/\r?\n/g, ' ').trim() + '...' : 'N/A'}\n\n`;
      logContent += `***\n\n`;
      try { fs.appendFileSync(logPath, logContent, 'utf8'); } catch {}
    }
  };

  const searchEngines = [
    { name: 'DuckDuckGo', build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDDG },
    { name: 'Bing', build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10`, parse: parseBing },
    { name: 'Mojeek', build: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, parse: parseMojeek },
  ];

  return {
    async webfetch({ url, raw = false }) {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

      let res, err;
      try {
        res = await fetchRetry(url, { redirect: 'follow', headers: { 'User-Agent': UA } }, { timeoutMs: 30000 });
      } catch (e) { err = e; }

      const timestamp = new Date().toLocaleString();
      let statusText = 'Failed';
      let outgoingLinks = [];
      let type = '';
      let body = '';

      if (res) {
        statusText = `HTTP ${res.status}`;
        type = res.headers.get('content-type') || '';
        body = await res.text();

        if (type.includes('html')) {
          try {
            const u = new URL(url);
            const origin = u.origin;
            const regex = /<a\s+(?:[^>]*?\s+)?href=["'](https?:\/\/[^"']+)["']/gi;
            let match;
            while ((match = regex.exec(body)) !== null) {
              const link = match[1];
              if (!outgoingLinks.includes(link) && !link.startsWith(origin)) {
                outgoingLinks.push(link);
                if (outgoingLinks.length >= 10) break;
              }
            }
          } catch {}
        }

        if (!raw && type.includes('html')) body = htmlToText(body);
        const limit = (ctx && ctx.provider && ctx.provider.contextTokens) || (ctx && ctx.cfg && ctx.cfg.contextTokens) || 200000;
        const maxChars = limit <= 8192 ? 12000 : 40000;
        if (body.length > maxChars) {
          body = body.slice(0, maxChars) + `\n…[truncated ${body.length - maxChars} chars]`;
        }
      } else {
        statusText = `Error: ${err.message}`;
      }

      // Automatic Audit Log Writing for Focus Sessions
      if (ctx && ctx.focusSession && ctx.cwd) {
        const logPath = path.join(ctx.cwd, 'research_audit_log.md');
        let logContent = '';
        if (!fs.existsSync(logPath)) {
          logContent += `# Research Audit Log\n\n`;
          logContent += `*   **Session ID:** ${ctx.focusSession.id}\n`;
          logContent += `*   **Description:** ${ctx.focusSession.description}\n`;
          logContent += `*   **Started:** ${new Date(ctx.focusSession.createdAt).toLocaleString()}\n\n`;
          logContent += `## Visited Websites\n\n`;
        }
        logContent += `### Visit: ${url}\n`;
        logContent += `*   **Time:** ${timestamp}\n`;
        logContent += `*   **Status:** ${statusText}\n`;
        if (outgoingLinks.length > 0) {
          logContent += `*   **Led to Outgoing Links:**\n`;
          outgoingLinks.forEach((link) => { logContent += `    *   ${link}\n`; });
        } else {
          logContent += `*   **Led to Outgoing Links:** None detected\n`;
        }
        logContent += `*   **Initial Snippet:** ${body ? body.slice(0, 300).replace(/\r?\n/g, ' ').trim() + '...' : 'N/A'}\n\n`;
        logContent += `*   **Findings**: *(To be completed by agent)*\n\n`;
        logContent += `***\n\n`;
        try { fs.appendFileSync(logPath, logContent, 'utf8'); } catch {}
      }

      if (err) throw err;
      return `${statusText} ${type}\n\n${body}`;
    },

    async websearch({ query }) {
      const errors = [];
      for (const eng of searchEngines) {
        // Negative cache: skip engines known to have just failed for this query.
        const negKey = cacheKey('wfail', eng.name, query);
        if (cacheGet(negKey)) {
          errors.push(`${eng.name}: previously failed (cached)`);
          continue;
        }
        const key = cacheKey('websearch', eng.name, query);
        let html = cacheGet(key);
        if (html === null) {
          try {
            const res = await fetchRetry(eng.build(query), {
              redirect: 'follow',
              headers: { 'User-Agent': UA },
            }, { retries: 0, timeoutMs: 8000 });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            html = await res.text();
            cacheSet(key, html);
          } catch (err) {
            cacheSet(negKey, 1); // remember the failure for 1h so sweeps don't re-hang
            errors.push(`${eng.name}: ${err.message}`);
            continue;
          }
        }
        const results = eng.parse(html);
        if (!results.length) {
          cacheSet(negKey, 1);
          errors.push(`${eng.name}: no results`);
          continue;
        }
        return formatSearchResults(results, query, eng.name);
      }
      return `Web search failed on all engines (${errors.join('; ')}). Try a structured search instead: search_repos (GitHub code/tools), search_packages (npm modules), search_news (Hacker News discussions), or rss_fetch (a known feed URL).`;
    },

    async search_repos({ q, limit = 8 }) {
      if (!q || !q.trim()) return 'Provide a query (q).';
      const key = cacheKey('search_repos', q, String(limit));
      let body = cacheGet(key);
      if (body === null) {
        try {
          const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(10, limit)}`;
          const res = await fetchRetry(url, { headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' } }, { retries: 1, timeoutMs: 20000 });
          if (!res.ok) {
            if (res.status === 403 || res.status === 429) {
              return `GitHub rate limit hit (HTTP ${res.status}). Wait a minute and vary the query, or use websearch/search_packages instead.`;
            }
            if (res.status === 422) return `GitHub rejected the query (HTTP 422) — simplify it.`;
            throw new Error(`HTTP ${res.status}`);
          }
          body = await res.text();
          cacheSet(key, body);
        } catch (err) {
          return `search_repos failed: ${err.message}`;
        }
      }
      try {
        const data = JSON.parse(body);
        const items = (data.items || []).slice(0, limit);
        if (!items.length) return `No GitHub repos found for "${q}". Try a broader term.`;
        let out = `GitHub Repos for "${q}":\n\n`;
        items.forEach((r, i) => {
          out += `${i + 1}. **${r.full_name}** ⭐${r.stargazers_count || 0}${r.language ? ` · ${r.language}` : ''}\n`;
          if (r.description) out += `   ${String(r.description).slice(0, 300)}\n`;
          out += `   URL: ${r.html_url || `https://github.com/${r.full_name}`}\n`;
        });
        return out;
      } catch (err) { return `search_repos parse error: ${err.message}`; }
    },

    async search_packages({ q, limit = 8 }) {
      if (!q || !q.trim()) return 'Provide a query (q).';
      const key = cacheKey('search_packages', q, String(limit));
      let body = cacheGet(key);
      if (body === null) {
        try {
          const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${Math.min(20, limit)}`;
          const res = await fetchRetry(url, { headers: { 'User-Agent': UA } }, { retries: 1, timeoutMs: 20000 });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          body = await res.text();
          cacheSet(key, body);
        } catch (err) {
          return `search_packages failed: ${err.message}`;
        }
      }
      try {
        const data = JSON.parse(body);
        const objects = (data.objects || []).slice(0, limit);
        if (!objects.length) return `No npm packages found for "${q}". Try a broader term.`;
        let out = `npm Packages for "${q}":\n\n`;
        objects.forEach((o, i) => {
          const p = o.package || {};
          const link = (p.links && (p.links.repository || p.links.homepage || p.links.npm)) || '';
          out += `${i + 1}. **${p.name}**@${p.version || '?'}\n`;
          if (p.description) out += `   ${String(p.description).slice(0, 300)}\n`;
          if (link) out += `   Link: ${link}\n`;
        });
        return out;
      } catch (err) { return `search_packages parse error: ${err.message}`; }
    },

    async search_news({ q, limit = 8 }) {
      if (!q || !q.trim()) return 'Provide a query (q).';
      const key = cacheKey('search_news', q, String(limit));
      let body = cacheGet(key);
      if (body === null) {
        try {
          const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=${Math.min(20, limit)}`;
          const res = await fetchRetry(url, { headers: { 'User-Agent': UA } }, { retries: 1, timeoutMs: 20000 });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          body = await res.text();
          cacheSet(key, body);
        } catch (err) {
          return `search_news failed: ${err.message}`;
        }
      }
      try {
        const data = JSON.parse(body);
        const hits = (data.hits || []).slice(0, limit);
        if (!hits.length) return `No Hacker News stories for "${q}". Try a broader term.`;
        let out = `Hacker News stories for "${q}":\n\n`;
        hits.forEach((h, i) => {
          const when = h.created_at ? new Date(h.created_at).toLocaleDateString() : '';
          const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
          out += `${i + 1}. **${h.title || '(untitled)'}** (${when})\n`;
          out += `   ▲ ${h.points || 0} · ${h.num_comments || 0} comments · by ${h.author || '?'}\n`;
          out += `   URL: ${url}\n`;
        });
        return out;
      } catch (err) { return `search_news parse error: ${err.message}`; }
    },

    async rss_fetch({ url, limit = 10 }) {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const key = cacheKey('rss_fetch', url, String(limit));
      let body = cacheGet(key);
      if (body === null) {
        try {
          const res = await fetchRetry(url, { redirect: 'follow', headers: { 'User-Agent': UA } }, { retries: 1, timeoutMs: 20000 });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          body = await res.text();
          if (!/<(rss|feed|rdf|entry|item)\b/i.test(body)) throw new Error('not an RSS/Atom feed');
          cacheSet(key, body);
        } catch (err) {
          return `rss_fetch failed for ${url}: ${err.message}`;
        }
      }
      const items = parseRSS(body).slice(0, limit);
      if (!items.length) return `Feed parsed but no items found: ${url}`;
      let out = `Feed: ${url}\n\n`;
      items.forEach((it, i) => {
        out += `${i + 1}. **${it.title || '(untitled)'}**\n`;
        if (it.url) out += `   URL: ${it.url}\n`;
      });
      return out;
    },

    async tavily_search({ query, maxResults = 5, searchDepth = 'basic', includeAnswer = true }) {
      if (!query || !query.trim()) return 'Provide a query.';
      const integrations = (ctx && ctx.cfg && ctx.cfg.integrations) || {};
      const apiKey = integrations.tavilyApiKey || process.env[integrations.tavilyApiKeyEnv || 'TAVILY_API_KEY'] || '';
      if (!apiKey) return 'No Tavily API key configured. Add one in Settings → Integrations, or set the TAVILY_API_KEY environment variable.';

      const key = cacheKey('tavily_search', query, searchDepth, String(maxResults), String(includeAnswer));
      let body = cacheGet(key);
      if (body === null) {
        try {
          const res = await fetchRetry('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: apiKey,
              query,
              search_depth: searchDepth,
              max_results: Math.min(20, Math.max(1, maxResults)),
              include_answer: includeAnswer,
            }),
          }, { retries: 1, timeoutMs: 20000 });
          if (!res.ok) {
            if (res.status === 401 || res.status === 403) return `Tavily rejected the API key (HTTP ${res.status}). Check the key in Settings → Integrations.`;
            if (res.status === 432 || res.status === 433) return `Tavily usage limit reached (HTTP ${res.status}).`;
            throw new Error(`HTTP ${res.status}`);
          }
          body = await res.text();
          cacheSet(key, body);
        } catch (err) {
          return `tavily_search failed: ${err.message}`;
        }
      }
      try {
        const data = JSON.parse(body);
        const results = (data.results || []).slice(0, maxResults);
        if (!results.length && !data.answer) return `No Tavily results for "${query}".`;
        let out = `Tavily Search Results for "${query}":\n\n`;
        if (data.answer) out += `**Answer:** ${data.answer}\n\n`;
        results.forEach((r, i) => {
          out += `${i + 1}. **${r.title || '(untitled)'}**\n`;
          out += `   URL: ${r.url}\n`;
          if (r.content) out += `   Snippet: ${String(r.content).slice(0, 400)}\n`;
        });
        return out;
      } catch (err) { return `tavily_search parse error: ${err.message}`; }
    },
  };
}

module.exports = { defs, makeExecutors };