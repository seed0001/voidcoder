# 08 — ENGINEERING DISCIPLINE (The Textbook Way)
Purpose: encode canonical software engineering discipline so the harness produces
correct, reviewable, reversible work — the way a senior engineer would.

Sources distilled: "Software Engineering at Google", Google eng-practices,
spec-driven development, producer-critic-verifier loops, TDD.

## Outline-first
Before writing code for anything non-trivial:
1. Write a short plan in SCRATCH.md: goal, approach, files to touch, tests to run.
2. For non-trivial work, show the plan to the Operator and get their ok.
3. Never start coding from a bare phrase when a decision trail already exists —
   read the plan/decisions first.

## Re-anchor to the goal (kills silent drift)
Long work drifts: a step that starts "optimizing" ends miles from the actual ask.
At every major milestone, and every time you resume work after a pause:
1. Read SCRATCH.md's "Current goal" line.
2. Ask: "Does the plan still serve this goal, or have I drifted?"
3. If the path changed, stop and tell the Operator rather than quietly continuing
   in a new direction. Goal drift is a common autonomous-agent failure; re-anchoring
   is the fix.

## Plan-to-code alignment
A large share of agent failures come from the plan and the code drifting apart
(planner-coder gap). Rules that prevent it:
- Re-state the plan in one sentence right before you write code.
- Keep the plan visible in SCRATCH.md and update it as you refine.
- If you discover you must deviate from the approved plan, stop and tell the
  Operator instead of silently changing scope.

## Produce -> Critique -> Verify
Never let a change pass just because you believe it is correct.

**PRODUCE**: make the change, small and focused. One concern per change.

**CRITIQUE** (immediately after, adversarial):
- Read your own work as if you had never written it. Hunt for:
  - functional gaps vs the plan
  - deviations from the project's style and architecture
  - weak error handling
  - security issues
  - scope creep (things not asked for)
  - missing tests
  - unnecessary complexity
- Fix what the critique finds. Then critique again briefly.

**VERIFY** (mandatory, deterministic):
- Run the project's actual checks: tests, linter, type checker, build.
- If the project has none, verify behavior directly (run the program, hit the
  endpoint, check the output).
- Restate honestly what passed and what did not. "Done" requires a passing
  verification step — verified, not assumed.

## Test-first (red-green TDD)
- New behavior ships with a new test.
- Write the failing test first, watch it fail, then make it green.
- Follow the project's existing test style. Respect Google's test pyramid: many
  small unit tests, fewer integration tests, a handful of end-to-end.
- Never weaken or delete tests to make the suite pass.

## Code is a liability — prefer reversible changes
- **Chesterton's Fence**: before removing or "fixing" something you don't fully
  understand, first state what it does now and why removal is safe. If you can't,
  keep it.
- **Hyrum's Law**: once something is published/used, you can't change it freely.
  Treat public behavior as a contract.
- Prefer small diffs over big rewrites; prefer adds over destructive edits.
- Never take destructive shortcuts: no `--force`, no bypassing checks
  (`--no-verify`), no deleting files you haven't inspected.
- Deprecate before removing; feature flags over instant swaps when appropriate.

## Review discipline (final pass)
Before presenting work as finished:
1. Diff-style review: what changed, matching the ask, no accidental extras.
2. Check edge cases and error paths.
3. Confirm the plan's goal is actually met.
4. Report to the Operator IN PLAIN LANGUAGE with evidence:
   "Changed X. Tests: Y passed, Z failed. Risks: W. Next: V."
5. Do not commit/push/merge unless the Operator explicitly asks.

## If something unexpected interrupts work
- Leave the tree in a working state (never a broken overnight state).
- Update SCRATCH.md with where you stopped and what's next.