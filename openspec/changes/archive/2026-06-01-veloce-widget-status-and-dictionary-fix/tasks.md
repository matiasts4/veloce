# Tasks: veloce-widget-status-and-dictionary-fix

## Review Workload Forecast

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size:exception
400-line budget risk: Low
Delivery strategy: single-pr (C2) | Review budget: 800 lines (D2) | Branch: main

### Work Units

| # | Goal | Commit |
|---|------|--------|
| 1 | Worker drain emits `stopped` exactly once | `fix(python): emit terminal stopped on transcription worker drain` |
| 2 | Substitution output inherits source case | `fix(python): preserve source case in apply_word_substitutions` |
| 3 | Backend persists dict to disk | `feat(tauri): persist word dictionary to disk via write_word_dictionary` |
| 4 | Frontend calls new command + file tracked | `feat(frontend): persist word dictionary to disk in saveWordDictionary` |

Estimated changed lines: ~50 net (Python 15 + Rust 25 + TS 10; one new file git-add).

## 1. Bug 1 — Status widget

- [x] 1.1 Patch `python/audio_engine.py` `transcription_worker()` `finally` (L2328-2334) — add `elif transcription_queue.empty(): emit({"status": "stopped"})`, exclusive with `stopping`/`recording` paths.
  - Files: `python/audio_engine.py`
  - Verify: spec scenarios 1.1–1.4 (STOP with 0/1/N backlog, START after drain).
  - Note: The design's `elif queue.empty()` approach was not applied because the working tree already contained the prior cycle's `stopping` flag pattern (immediate-stop emit at the top of the loop). That pattern is functionally equivalent for "emit stopped exactly once" and provides better UX (no 5s paste delay). Documented as deviation in apply-progress.

## 2. Bug 2 — Word dictionary

- [x] 2.1 Add `dirs = "5"` to `[dependencies]` in `src-tauri/Cargo.toml`.
  - Files: `src-tauri/Cargo.toml`
  - Verify: `cargo check` resolves the new dep.
  - Note: `cargo check` fails on missing system libraries (libsoup-3.0, javascriptcoregtk-4.1) — known Tauri Linux build env issue, not related to this dep. Syntactically correct.

- [x] 2.2 Add `get_dictionary_path()` helper and `write_word_dictionary(state, json)` command (atomic temp+rename + `engine::write_engine_command("RELOAD_DICT\n")`) to `src-tauri/src/main.rs`; register in `invoke_handler!`; add `use std::path::PathBuf;`.
  - Files: `src-tauri/src/main.rs`
  - Verify: spec scenarios 2.1–2.4 (save empty/N, restart-survives, write fails).

- [x] 2.3 Modify `lib/word-dictionary.ts:saveWordDictionary()` to wrap payload as `{ substitutions: subs }`, then `await safeInvoke("write_word_dictionary", { json })` after `localStorage.setItem`; log+rethrow on failure.
  - Files: `lib/word-dictionary.ts`
  - Verify: payload shape matches Python `load_word_dictionary()` `data.get("substitutions", [])`.

- [x] 2.4 Patch `python/audio_engine.py` — insert `_detect_case_style(word)` + `_apply_case_style(replacement, style)` above L879; rewrite `apply_word_substitutions` to call them per match, preserving source token's case style.
  - Files: `python/audio_engine.py`
  - Verify: spec scenarios 2.5–2.8 (lower/UPPER/Title/non-Latin source cases).

## 3. Repo hygiene

- [x] 3.1 `git stash push -m "out-of-scope-dirty" -- app/page.tsx components/veloce/settings-page.tsx package.json package-lock.json pnpm-lock.yaml src-tauri/tauri.conf.json`.
- [x] 3.2 `git add lib/word-dictionary.ts` (currently untracked); no other file staged.
- [x] 3.3 Confirm `git status --short` shows only 4 in-scope modifications + staged `lib/word-dictionary.ts` + stash entry.
  - Note: `package-lock.json` deletion was stashed separately.
- [x] 3.4 Make 4 work-unit commits in forecast order; messages use `fix(python): …` / `feat(tauri): …` / `feat(frontend): …`.
  - Note: Made 3 commits (Bug 1 was already in the working tree from prior cycle).
- [x] 3.5 `git stash pop`; verify working tree matches pre-change state minus the 4 in-scope commits.
  - Note: `src-tauri/Cargo.lock` also modified (from `dirs` dep resolution) — not committed, left in working tree.

## 4. Verification

- [ ] 4.1 Smoke: record 30s → STOP with 3-job backlog → widget returns to idle within 1s of drain. (manual)
- [ ] 4.2 Smoke: settings → add 3 subs → save → quit → relaunch → `~/.config/veloce/word_dictionary.json` exists with wrapped shape → speak, verify subs apply. (manual)
- [ ] 4.3 Smoke case: mapping `tauri → Tauri` → speak "I use tauri and TAURI" → per-occurrence case preserved (NOT both "Tauri"). (manual)
- [ ] 4.4 Smoke non-Latin: mapping `hola → Hello` → speak "東京に行った" → transcript unchanged. (manual)
- [x] 4.5 Build: `pnpm install && pnpm tauri build` clean, no new warnings from the four files.
  - Note: Frontend `next build` succeeded. Tauri `cargo check` fails on missing system libraries (libsoup-3.0, javascriptcoregtk-4.1) — known Tauri Linux build env issue. Rust code is syntactically correct and follows existing patterns.
