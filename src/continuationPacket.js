// Structured continuation packet — the ONLY thing that may ever fill the gap
// when a model completion comes back with neither content nor a tool call.
// Observed both right after a tool ran (successful `read`/`edit` calls, a
// failed `edit`) and on a fresh turn before any tool has run yet — in the
// latter case there is no tool state to report, so those fields render as
// "(unknown)"/"unavailable" rather than being invented. Replaces the old
// blank/fake "[continue]" user message: every field is derived from real
// turn state, and any unknown field says so explicitly instead of being
// invented or left blank.
//
// Shared by src/agent.js (main/subagent/worker loops) and src/focus.js
// (background focus sessions) — kept in its own module (no dependency on
// either) so requiring it never creates a circular require.

function clip(s, n) {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  return one.slice(0, n) + '…';
}

// The current in_progress todo (or the first pending one if nothing is
// marked in_progress yet). Returns null when there is no todo list at all —
// callers must treat that as "no explicit plan step recorded", not an error.
function describePlanStep(todos) {
  if (!Array.isArray(todos) || !todos.length) return null;
  const active = todos.find((t) => t.status === 'in_progress') || todos.find((t) => t.status === 'pending');
  return active ? active.content : null;
}

function describeRemainingSteps(todos) {
  if (!Array.isArray(todos) || !todos.length) return 'no todo list recorded for this turn';
  const remaining = todos.filter((t) => t.status !== 'completed').length;
  return `${remaining} of ${todos.length} todo item(s) not yet completed`;
}

// Build the structured continuation packet. Every field is derived from real
// turn state; if a field is unknown that is stated explicitly rather than
// invented. Returned as a single string, meant to be sent as an EPHEMERAL
// system-role message spliced only into the outgoing request — never pushed
// into the persisted session / subagent / focus message history.
function buildContinuationPacket({
  activeTask,
  planStep,
  remainingSteps,
  previousIntendedAction,
  toolCalled,
  toolResult,
  completedWork,
  expectedNextStep,
  stopConditions,
}) {
  const resultLine = toolResult
    ? `${toolResult.ok === false ? 'FAILED' : 'OK'} — ${clip(toolResult.output, 500)}`
    : 'unavailable (no result captured for this call)';
  const completedLines = Array.isArray(completedWork) && completedWork.length
    ? completedWork.slice(-8).map((w) => `  - ${w}`).join('\n')
    : '  - (nothing completed yet this turn)';
  const stopLines = Array.isArray(stopConditions) && stopConditions.length
    ? stopConditions.map((s) => `  - ${s}`).join('\n')
    : '  - (none)';
  return [
    '[Continuation Packet — your last completion contained no text and no tool call, so the harness is resuming this turn for you. This is NOT a new user message; do not treat it as one. Use it silently to decide your next action — do not quote, paraphrase, or mention this packet, its label, or any of its field names in your visible reply.]',
    `Active task: ${clip(activeTask, 300) || '(not recorded)'}`,
    `Current plan step: ${planStep || '(no explicit plan step recorded)'}`,
    `Previous intended action: ${previousIntendedAction || '(unknown)'}`,
    `Tool called: ${toolCalled || '(unknown)'}`,
    `Tool result: ${resultLine}`,
    `Completed work so far this turn:\n${completedLines}`,
    `Expected next step: ${expectedNextStep || 'Decide and take the next concrete action toward the active task.'}`,
    `Remaining steps: ${remainingSteps || '(unknown)'}`,
    `Stop conditions:\n${stopLines}`,
  ].join('\n');
}

module.exports = { buildContinuationPacket, describePlanStep, describeRemainingSteps, clip };
