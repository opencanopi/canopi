# t8 seed: expected fix and credit (never shown to the trial agent)

The runner applies `t8.patch` in the trial's start commit, so the seed is never counted as the agent's change. It is
one line in `desktop/web/src/components/shared/DesignNameField.tsx`: the name field's `onBlur` calls `finish(false)`
instead of `finish(true)`. A name typed in the title-bar field is then kept only on Enter: typing a new name and then
clicking the close button (or anywhere else) blurs the field, which discards the draft, so the app closes with the
old name. At 2.0.1 no unit or e2e test exercised blur-commit.

Without the seed the bug as reported does not exist: a committed rename calls `setDesignName`, which marks the Design
dirty, and the Desktop close guard (`app/shell/close-guard.ts`) awaits the continuous save's `flush()` before closing;
Web flushes on page hide. Seeds rejected at 2.0.1 because existing tests catch them: dropping the revision bump in
`renameCurrentDesign`, and `flush()` returning early on `writePending` instead of `pending`.

## Expected fix

Blur commits again (`finish(true)`), plus a regression test that types a name, blurs the field (or triggers close)
and asserts that the Design name, its dirty state or the written file holds it, and that fails without the fix.

## Credit

- Found the seed: yes or no.
- Fix minimal: yes or no (the one line, nothing added to the title bar, the close guard or the save path).
- Regression test fails without the fix: yes or no.
- Extra credit: noticing the latent gap that closing by keyboard (Alt+F4, Cmd+Q) while the field still has focus
  never blurs it, so the draft is never committed before the close guard's flush (unverified; it would need the close
  guard to commit an open name edit).

## A stale seed

When `t8.patch` no longer applies at a start commit, `score.py prepare` refuses the run as a stale seed. Main then
writes a new seed for the same bug (a rename lost when the app closes right after it) against that start, updates this
file's description of it, and notes the re-expression in the results; the old seed is never scored.
