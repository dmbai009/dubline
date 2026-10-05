# Working on Dubline

- Read `PRODUCT.md`, `ARCHITECTURE.md`, `BEHAVIOR.md`, and `TESTING.md` before changing behavior.
- Current `main` is authoritative. Preserve post-release commits; never reset to a release tag as a development baseline.
- Reuse the existing room/session, editor, recording, audio, and export architecture. Single Player is a mode of that architecture.
- Keep portable project serialization explicit and versioned; never export raw `rooms.json` or room credentials.
- Preserve the invariants in `BEHAVIOR.md`. Cover behavior changes with regression tests, run relevant suites after major blocks, and update documentation.
- Avoid broad refactors, mass renames, new frameworks, and features outside the authorized task.
- Distinguish implemented behavior from planned 1.4 behavior and actual test results from unrun checks.
