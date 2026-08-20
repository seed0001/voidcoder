// Bug reports: primarily posts to the VoidCoder website's /api/bug-report
// endpoint, which holds a shared GitHub token as a server-side secret and
// files the issue on the user's behalf — no per-user GitHub token required.
// If that endpoint is unreachable or not configured (e.g. BUG_REPORT_GITHUB_TOKEN
// isn't set on Railway yet), and the user has their own GitHub token configured
// in Settings (integrations.githubToken), falls back to filing the issue
// directly with that token. If neither works, falls back further to a
// pre-filled "new issue" URL to open manually in a browser.

const os = require('os');
const { version: APP_VERSION } = require('../package.json');

const REPO_OWNER = 'seed0001';
const REPO_NAME = 'voidcoder';
const CATEGORIES = ['bug', 'feature-request', 'question'];
const REPORT_ENDPOINT = process.env.VOIDCODE_BUGREPORT_ENDPOINT || 'https://voidcoder-website-production.up.railway.app/api/bug-report';

function githubToken(cfg) {
  return (cfg && cfg.integrations && cfg.integrations.githubToken) || process.env.GITHUB_TOKEN || '';
}

function manualIssueUrl({ title, body, category }) {
  const labels = ['bug-report', ...(CATEGORIES.includes(category) ? [category] : [])];
  const params = new URLSearchParams({ title: title || '', body: body || '', labels: labels.join(',') });
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new?${params.toString()}`;
}

function formatBody({ description, context = {} }) {
  const parts = [description.trim()];
  const envLines = [
    `VoidCode ${APP_VERSION}`,
    `${os.platform()} ${os.release()}`,
    context.provider ? `provider: ${context.provider}${context.model ? '/' + context.model : ''}` : null,
  ].filter(Boolean);
  parts.push('', '<details><summary>Environment</summary>', '', envLines.join('  \n'), '', '</details>');
  if (context.recentError) {
    parts.push('', '<details><summary>Recent error</summary>', '', '```', String(context.recentError).slice(0, 2000), '```', '</details>');
  }
  return parts.join('\n');
}

async function submitViaWebsite({ finalTitle, description, finalCategory, submittedBy, context }) {
  const res = await fetch(REPORT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: finalTitle,
      description,
      category: finalCategory,
      submittedBy,
      version: APP_VERSION,
      platform: `${os.platform()} ${os.release()}`,
      provider: context.provider || null,
      model: context.model || null,
      recentError: context.recentError ? String(context.recentError) : null,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `report server responded ${res.status}`);
  return { ok: true, url: data.url, number: data.number };
}

async function submitDirectToGithub({ token, finalTitle, body, finalCategory, submittedBy }) {
  const labels = ['bug-report', finalCategory];
  if (submittedBy === 'agent') labels.push('filed-by-agent');
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'VoidCode-BugReport',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: finalTitle, body, labels }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  return { ok: true, url: data.html_url, number: data.number };
}

// submittedBy: 'user' (manual button) | 'agent' (the AI filed it itself) —
// tagged as a label so reports can be told apart in the tracker.
async function submitBugReport(cfg, { title, description, category = 'bug', context = {}, submittedBy = 'user' } = {}) {
  if (!description || !description.trim()) return { ok: false, error: 'description is required' };
  const finalCategory = CATEGORIES.includes(category) ? category : 'bug';
  const finalTitle = (title && title.trim()) || description.trim().split('\n')[0].slice(0, 72);
  const body = formatBody({ description, context });

  let websiteError;
  try {
    return await submitViaWebsite({ finalTitle, description, finalCategory, submittedBy, context });
  } catch (err) {
    websiteError = err.message;
  }

  const token = githubToken(cfg);
  if (token) {
    try {
      return await submitDirectToGithub({ token, finalTitle, body, finalCategory, submittedBy });
    } catch (err) {
      return {
        ok: false,
        error: `${websiteError}; direct GitHub submit also failed: ${err.message}`,
        manualUrl: manualIssueUrl({ title: finalTitle, body, category: finalCategory }),
      };
    }
  }

  return {
    ok: false,
    error: websiteError,
    manualUrl: manualIssueUrl({ title: finalTitle, body, category: finalCategory }),
  };
}

module.exports = { submitBugReport, manualIssueUrl, CATEGORIES, REPO_OWNER, REPO_NAME };
