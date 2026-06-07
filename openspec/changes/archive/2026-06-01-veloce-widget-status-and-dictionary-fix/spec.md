# Delta Spec: veloce-widget-status-and-dictionary-fix

## Context

Delta over the archived change `veloce-word-dictionary-and-status-fixes` (archived 2026-05-30), which closed the bugs on paper but missed three defects:

1. `transcription_worker()` `finally` (`python/audio_engine.py:2328-2334`) has no terminal `stopped` event for the post-STOP drain case.
2. Frontend writes substitutions to `localStorage`; the disk file the Python engine reads is never written — no writer exists.
3. **Newly discovered** at proposal time: `apply_word_substitutions()` matches case-insensitively but writes the user-stored `to` verbatim, ignoring the case style of the source word.

All commits land on `main` directly. `lib/word-dictionary.ts` is untracked and MUST be `git add`-ed in apply.

## ADDED Requirements

### Requirement: Transcription Status Returns to Idle After Backlog Drain

The system SHALL emit `{"status": "stopped"}` from the worker `finally` when neither `recording` nor `stopping` is True. The new branch SHALL be mutually exclusive with the existing `stopping=True` early-skip path, so no duplicate `stopped` is emitted.

#### Scenario: STOP with empty queue

- GIVEN recording in progress AND queue is empty
- WHEN the user invokes STOP
- THEN no extra `stopped` is emitted from the worker `finally`
- AND the widget transitions to idle via the STOP-path event

#### Scenario: STOP with one pending job

- GIVEN recording in progress AND one job queued
- WHEN the user invokes STOP
- THEN the worker processes the final job
- AND emits `{"status": "stopped"}` exactly once (on the `finally` iteration where both flags are False)

#### Scenario: STOP with N pending jobs

- GIVEN recording in progress AND N > 1 jobs queued
- WHEN the user invokes STOP
- THEN the worker processes all N jobs
- AND emits `{"status": "stopped"}` exactly once on the final `finally` iteration

#### Scenario: START immediately after drain

- GIVEN the worker has fully drained after STOP
- WHEN the user invokes START
- THEN the engine transitions to `listening`
- AND no stale `stopped` races the new `listening`

### Requirement: Word Dictionary Persists Across Backend Reloads

Frontend `saveWordDictionary()` SHALL persist substitutions to `localStorage` AND to `get_app_data_dir()/word_dictionary.json` via a new Tauri command `write_word_dictionary`. The command SHALL write atomically (temp file + rename in the same directory) and SHALL send `RELOAD_DICT\n` to the Python engine. Python `load_word_dictionary()` SHALL treat a missing file as a no-op. `lib/word-dictionary.ts` SHALL be tracked in git.

#### Scenario: save with zero entries

- GIVEN an empty substitution list
- WHEN the user saves the dictionary
- THEN `localStorage` contains `[]`
- AND `word_dictionary.json` exists on disk containing `[]`
- AND the engine receives `RELOAD_DICT`

#### Scenario: save with N entries

- GIVEN a substitution list of N entries
- WHEN the user saves
- THEN the on-disk file matches the frontend payload byte-for-byte
- AND the engine applies the new entries on subsequent transcriptions

#### Scenario: dictionary survives backend restart

- GIVEN substitutions were saved in a previous session
- WHEN the backend restarts
- THEN `load_word_dictionary()` reads the same entries
- AND applies them to the first transcription of the new session

#### Scenario: disk write fails

- GIVEN the file cannot be written (permissions, missing parent dir, disk full)
- WHEN `saveWordDictionary()` is invoked
- THEN the Tauri command returns an error
- AND `localStorage` remains the source of truth
- AND the UI surfaces a non-fatal error
- AND the engine continues with the prior in-memory dictionary (stale, not broken)

### Requirement: Word Substitution Preserves Source Case Style

`apply_word_substitutions()` SHALL compare match keys case-insensitively (current behavior) and SHALL apply the user's `to` using the case style of the source word as transcribed:

| Source case in transcript | Output |
|---|---|
| ALL UPPERCASE (e.g. "TAURI") | user's `to` rendered ALL UPPERCASE |
| Title Case (e.g. "Tauri") | user's `to` rendered in Title Case |
| All lowercase (e.g. "tauri") | user's `to` as-is |
| Mixed (e.g. "tAuRi") or non-Latin (e.g. "東京") | user's `to` as-is |

#### Scenario: lowercase source

- GIVEN mapping `tauri → Tauri`
- WHEN the transcript contains "tauri"
- THEN the output contains "Tauri"

#### Scenario: ALL UPPERCASE source

- GIVEN mapping `tauri → Tauri`
- WHEN the transcript contains "TAURI"
- THEN the output contains "TAURI"

#### Scenario: Title Case source

- GIVEN mapping `tauri → tauri inc`
- WHEN the transcript contains "Tauri"
- THEN the output contains "Tauri Inc"

#### Scenario: non-Latin source

- GIVEN mapping `hola → Hello`
- WHEN the transcript contains "東京"
- THEN the output is unchanged ("東京")
- AND no error is raised
