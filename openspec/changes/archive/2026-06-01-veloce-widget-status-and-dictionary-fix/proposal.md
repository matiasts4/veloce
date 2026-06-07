# Proposal: veloce-widget-status-and-dictionary-fix

## Intent

Re-fix two bugs the prior cycle (`veloce-word-dictionary-and-status-fixes`, archived 2026-05-30) closed on paper but not in practice:

1. **Status widget stuck in cyan** after STOP while transcription jobs drain.
2. **Word substitution dictionary silently no-op** — UI writes to `localStorage`; Tauri command sends only `RELOAD_DICT\n`; Python engine reads a disk file nothing ever writes to.

**Why a new cycle, not an extension**: prior cycle was archived complete with a structurally wrong diagnosis (case-style never specified). Re-opening an archived change corrupts the audit trail.

## Scope

### In Scope
- Fix `transcription_worker()` `finally` (python/audio_engine.py:2328-2334) so post-STOP drain emits `{"status": "stopped"}`.
- Add Tauri command `write_word_dictionary(json)` (src-tauri/src/main.rs): writes payload to disk and signals the engine.
- Update `lib/word-dictionary.ts:saveWordDictionary()` to call the new command.
- Audit `apply_word_substitutions()` (python/audio_engine.py:879-892): output inherits case style of the transcribed word.
- `git add lib/word-dictionary.ts` (currently untracked).

### Out of Scope
- Settings UI rework, pre-roll buffer, new substitution features (regex/fuzzy).

## Capabilities

### Modified Capabilities
- `audio-transcription-pipeline`: post-STOP drain must emit a terminal status event.
- `word-substitution-dictionary`: persistence must round-trip UI → disk → engine; output case follows the transcribed word.

## Approach

1. `python/audio_engine.py:2328-2334` — add `else: emit({"status": "stopped"})` in `finally` for the `not stopping and not recording` drain case.
2. `src-tauri/src/main.rs` — new `write_word_dictionary(json)` command: create parent dirs, write to `get_app_data_dir()/word_dictionary.json`, send `RELOAD_DICT\n` via `engine::write_engine_command`.
3. `lib/word-dictionary.ts:20-28` — after `localStorage.setItem`, call `safeInvoke("write_word_dictionary", { json: JSON.stringify(subs) })`.
4. `python/audio_engine.py:879-892` — detect input case (lower/Title/UPPER), apply same style to replacement.
5. apply phase — `git add lib/word-dictionary.ts`.

**Estimated diff**: ~50 lines net (under 800-line budget).

## Affected Areas

- `python/audio_engine.py` — worker `finally` + case-style (~15 lines)
- `src-tauri/src/main.rs` — new command (~25 lines)
- `lib/word-dictionary.ts` — new invoke + `git add`
- `app/page.tsx` — optional: listener hardening only

## Risks

- **Race** (drain emits `stopped` after late `transcribing_final`): `else` branch is exclusive with `stopping=True` path.
- **Disk write fails**: Tauri `Result`; frontend keeps `localStorage` fallback.
- **Case detection breaks on non-Latin**: only transform if replacement is ASCII-letter.
- **`git add` conflicts with dirty M-files** (app/page.tsx, settings-page.tsx, etc.): stash unrelated files before staging.
- **Double `stopped` emission**: `else` only fires when `stopping=False`.

## Rollback Plan

`git revert <merge-commit>` on `main`. Both fixes are additive and independent — partial rollback by reverting individual commits.

## Branch Constraint (HARD)

All commits on `main` directly — no feature branch, worktree, or PR. Pre-existing M-files are out of scope.

## Dependencies

`engine::write_engine_command`, `get_app_data_dir()`, `apply_word_substitutions()` (python/audio_engine.py:2511).

## Success Criteria

- [ ] STOP with queued jobs: widget idle within 200ms of drain.
- [ ] "vosotros"→"ustedes" applies; "hola"→"Hello" preserves input case.
- [ ] `lib/word-dictionary.ts` tracked in git.
- [ ] Pre-roll drain + recording flow still work.
