// Bug reports: posts to the VoidCoder website's /api/bug-report endpoint,
// which holds the one shared GitHub token as a server-side secret and files
// the issue on the user's behalf — no per-user GitHub token required.
// Falls back to a pre-filled "new issue" URL if the website is unreachable,
// so reporting still works — just as a link to open instead of an automatic
// submit.

const os = require('os');
const { version: APP_VERSION } = require('../package.json');

const REPO_OWNER = 'seed0001';
const REPO_NAME = 'voidcoder';
const CATEGORIES = ['bug', 'feature-request', 'question'];
const REPORT_ENDPOINT = process.env.VOIDCODE_BUGREPORT_ENDPOINT || 'https://voidcoder-website-production.up.railway.app/api/bug-report';

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

  try {
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
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        error: data.error || `report server responded ${res.status}`,
        manualUrl: manualIssueUrl({ title: finalTitle, body, category: finalCategory }),
      };
    }
    return { ok: true, url: data.url, number: data.number };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      manualUrl: manualIssueUrl({ title: finalTitle, body, category: finalCategory }),
    };
  }
}

module.exports = { submitBugReport, manualIssueUrl, CATEGORIES, REPO_OWNER, REPO_NAME };
