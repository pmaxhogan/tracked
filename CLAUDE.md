<!-- stack:begin (managed by the stack plugin; edit via /stack:remember or by hand, keep the markers) -->

## Stack

- mode: deps.dependabot-mechanism=native
- mode: test.coverage-ratchet=ruleset
- exception: repo.no-protection - One ruleset on main: required status check 'check' plus the code_coverage rule (max drop 0.5 pt); repository admins bypass it so direct pushes to main still work. Reason: public repo uses native Dependabot auto-merge and the native coverage ruleset, which both need required checks. (2026-10-14)

<!-- stack:end -->
