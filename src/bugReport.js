// Bug reports: files a GitHub issue in the app's own repo so problems users
// hit (or that the agent notices mid-conversation) land somewhere trackable.
// Reuses the GitHub token already wired up for other integrations
// (src/config.js integrations.githubToken); falls back to a pre-filled
// "new issue" URL when no token is configured, so reporting still works —
// just as a link to open instead of an automatic submit.

const os = require('os');
const { version: APP_VERSION } = require('../package.json');

const REPO_OWNER = 'seed0001';
const REPO_NAME = 'voidcoder';
const CATEGORIES = ['bug', 'feature-request', 'question'];

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

// submittedBy: 'user' (manual button) | 'agent' (the AI filed it itself) —
// tagged as a label so reports can be told apart in the tracker.
async function submitBugReport(cfg, { title, description, category = 'bug', context = {}, submittedBy = 'user' } = {}) {
  if (!description || !description.trim()) return { ok: false, error: 'description is required' };
  const finalCategory = CATEGORIES.includes(category) ? category : 'bug';
  const finalTitle = (title && title.trim()) || description.trim().split('\n')[0].slice(0, 72);
  const body = formatBody({ description, context });
  const token = githubToken(cfg);

  if (!token) {
    return {
      ok: false,
      error: 'No GitHub token configured',
      manualUrl: manualIssueUrl({ title: finalTitle, body, category: finalCategory }),
    };
  }

  const labels = ['bug-report', finalCategory];
  if (submittedBy === 'agent') labels.push('filed-by-agent');

  try {
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
      return {
        ok: false,
        error: `GitHub API ${res.status}: ${errText.slice(0, 300)}`,
        manualUrl: manualIssueUrl({ title: finalTitle, body, category: finalCategory }),
      };
    }
    const data = await res.json();
    return { ok: true, url: data.html_url, number: data.number };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      manualUrl: manualIssueUrl({ title: finalTitle, body, category: finalCategory }),
    };
  }
}

module.exports = { submitBugReport, manualIssueUrl, CATEGORIES, REPO_OWNER, REPO_NAME };
