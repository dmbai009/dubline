# Working on Dubline

- Read README.md and the relevant code/tests before changing behavior. Application code lives in src/, tests in test/ and e2e/, and build/QA tools in tools/.
- Write all new or updated documentation, changelogs, and GitHub release notes in English only. Keep application UI localization separate from this documentation rule.
- Do not add AI agents or tools as commit co-authors. Preserve attribution to actual human contributors.
- Current `main` is authoritative. Preserve post-release commits; never reset to a release tag as a development baseline.
- Reuse the existing room/session, editor, recording, audio, and export architecture. Single Player is a mode of that architecture.
- Keep portable project serialization explicit and versioned; never export raw `rooms.json` or room credentials.
- Preserve permissions, session/revision binding, non-destructive recordings and personal/shared settings boundaries. Personal monitoring must not affect project exports.
- See docs/project-format.md for the portable format. Keep user storage paths stable; tests must use isolated temporary storage.
- Avoid broad refactors, mass renames, new frameworks, and features outside the authorized task.
- Distinguish implemented behavior from planned 1.4 behavior and actual test results from unrun checks.
