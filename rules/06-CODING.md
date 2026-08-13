# 06 — CODING STANDARDS & SELF-VERIFICATION
Purpose: produce real, working, safe code — and prove it works.

## Before writing code
1. State the plan in one or two sentences. Ask about anything ambiguous.
2. Prefer the simplest solution that works. Do not add abstractions "just in case".
3. Follow the existing style: match the project's language, naming, file layout, and
   libraries. Never assume a library exists — check the project first.
4. Load the project context pack (PROJECT.md / AGENTS.md — see 03) so your code
   matches the project's actual conventions.
5. Non-trivial work: follow the outline-first rule in 08-ENGINEERING (plan in
   SCRATCH.md, get Operator buy-in).

## While writing
- Keep changes small and reviewable. One concern per change.
- No secrets, no hardcoded credentials (see 04).
- Handle errors: don't swallow failures; return clear messages.
- Do not add fluff comments; write code that is readable on its own.

## Verification (mandatory — no exceptions)
You are biased toward your first plausible solution. Verify before claiming success.
Follow the Produce -> Critique -> Verify discipline in 08-ENGINEERING.
- Run the project's tests / lint / build if they exist:
  `npm test`, `pytest`, `go test`, `cargo test`, `ruff`, `tsc`, etc. — whatever the
  project uses. Check README or config to find out.
- If no test framework exists, verify behavior directly: run the program, check its
  output, or exercise the changed function.
- For websites/apps: boot the server and hit the endpoint yourself, don't just read
  the code.
- After a fix, prove the failure is gone by reproducing the original symptom.
- Consistency over luck: a feature that works "sometimes" is NOT done. Anything the
  Operator relies on should pass its verification at least twice (run the check,
  then run it again) — occasional success is not completion.
- Restate honestly what passed and what didn't. Never say "done" unless you can
  point to a passing verification.
- Deterministic checks to prefer when available (Google practice): compile/build,
  unit + integration tests, linters and type checkers, dependency & CVE scanning,
  secret scanning. "It compiled" is not the same as "it works".

## Tests
- When adding features, add or update tests in the project's existing test style.
- Follow red-green: write a failing test first where practical, then make it pass.

## Review discipline
- Review the diff before finishing: did the changes match the ask? Any accidental
  extras? Any edge cases missed? Any unnecessary churn?
- Do not merge/commit unless the Operator asks you to (or explicitly approves).
- New behavior ships with a new test (red-green TDD; see 08-ENGINEERING). Never
  weaken or delete tests to make the suite pass.

## Common failure modes to avoid
- Hallucinated dependencies: only install packages that exist and are needed.
- Over-engineering: extra layers the task didn't ask for.
- Untested claims: "this should work" is not completion.
- Editing files you haven't read yet.
- Removing code you don't understand (Chesterton's Fence; see 08-ENGINEERING).
- Destructive shortcuts (`--force`, `--no-verify`) to dodge safety checks.
- Leaving the project in a broken intermediate state overnight — prefer to finish a
  change or leave the tree working.