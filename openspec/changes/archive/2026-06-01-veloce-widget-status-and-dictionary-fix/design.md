# Design: veloce-widget-status-and-dictionary-fix

## Technical Approach

Three independent bug fixes targeting the `transcription_worker()` drain path (Python), the word-dictionary disk persistence path (Rust + TS), and the case-style preservation in substitution output (Python). All commits land directly on `main` per the H4 branch constraint. Net diff ~50 lines, well under the 800-line review budget.

## Architecture Decisions

| Decision | Choice | Tradeoff | Why |
|---|---|---|---|
| Worker drain terminal event | Add `else: emit stopped` to `finally` (gated on `transcription_queue.empty()`) | Loses the "immediate-stop wins" semantics; widget must wait for drain | Spec requires "exactly once on the final `finally` iteration". `queue.empty()` is racy in theory; safe in practice because `main_loop` only pushes while `recording=True`. |
| Rust config path | Add `dirs = "5"` crate, hardcode `veloce` segment | New dep | Matches Python `get_dictionary_path()` exactly across Win/macOS/Linux. Tauri 2's `app_config_dir()` would use bundle id `com.veloce.app` and not match. |
| Disk write atomicity | temp file + `std::fs::rename` (same dir) | One extra file lifecycle | Prevents partial writes from corrupting the dictionary. |
| Dict payload shape | `{ substitutions: subs }` wraps the array | Diverges from localStorage shape (bare array) | Matches Python loader `data.get("substitutions", [])`. Frontend keeps localStorage as-is for backward compat with `loadWordDictionary()`. |
| Case detection | 4-bucket classifier: `upper`/`title`/`lower`/`as-is` | Mixed-case falls through to `as-is` | Spec table maps these 4 to the 4 source-case scenarios. `as-is` covers mixed + non-Latin + empty. |

## Data Flow

### Bug 1 — Worker drain

```
[main loop: was_recording=True, not recording]
    processor.transcribe_all_pending()   ──►  queue: [jobA, jobB, jobC, STOP]
    queue.put({"type": "STOP"})
[worker iter 1] stopping=True → log, set stopping=False, FALL THROUGH
[worker iter 2] pop jobA → transcribe → finally: queue.empty()? No → no emit
[worker iter 3] pop jobB → transcribe → finally: queue.empty()? No → no emit
[worker iter 4] pop jobC → transcribe → finally: queue.empty()? No → no emit
[worker iter 5] pop STOP   → log       → finally: queue.empty()? Yes → emit stopped
[worker iter 6] queue.Empty → continue
```

**Mutual-exclusion proof (single iteration):** `if stopping: pass` and `else: emit stopped` cannot both execute — they are exclusive branches of the same `if/elif/elif/else` chain. The else fires only when `stopping=False AND recording=False`. The existing `elif recording: emit listening` is also exclusive.

**Unchanged paths:** `command_listener` `START` (audio_engine.py:2603) still emits `{"status": "recording"}`; `STOP` (line 2630) still only sets `stopping=True, recording=False` — no emit.

### Bug 2a — Tauri disk write

```
saveWordDictionary(subs)
  ├─ localStorage.setItem(KEY, JSON.stringify(subs))      [unchanged shape]
  └─ safeInvoke("write_word_dictionary", { json: '{"substitutions":[…]}' })
        └─ main.rs:write_word_dictionary
              ├─ dirs::config_dir().join("veloce").join("word_dictionary.json")
              ├─ create_dir_all(parent)
              ├─ write tmp file "word_dictionary.json.tmp"
              ├─ std::fs::rename(tmp → final)               [atomic on same FS]
              └─ engine::write_engine_command("RELOAD_DICT\n")
                    └─ Python command_listener line 2645 → load_word_dictionary()
```

**Failure path:** any IO error returns `Err(String)` to the frontend. `localStorage` remains source of truth. `word_substitutions` in Python engine is stale-but-not-broken (same as today's behavior with no disk file).

### Bug 2b — Case-style preservation

```
"tauri"... "Tauri"... "TAURI"  ──►  apply_word_substitutions
                                       ├─ tokenize on whitespace
                                       ├─ for each token: key = w.lower().strip(PUNCT)
                                       ├─ if key in word_substitutions:
                                       │     style = _detect_case_style(w)
                                       │     emit _apply_case_style(to, style)
                                       └─ else: emit w as-is
```

Each token position is handled independently — same token may appear as `tauri` and `TAURI` and produce different outputs. Documented in spec scenario "non-Latin source".

## File Changes

| File | Action | Description |
|---|---|---|
| `python/audio_engine.py` | Modify | `transcription_worker()` `finally` (L2328-2334) + new helpers `_detect_case_style`/`_apply_case_style` + `apply_word_substitutions` rewrite (L879-892) |
| `src-tauri/src/main.rs` | Modify | New `write_word_dictionary` command + `get_dictionary_path` helper; register in `invoke_handler!` |
| `src-tauri/Cargo.toml` | Modify | Add `dirs = "5"` dep |
| `lib/word-dictionary.ts` | Modify | `saveWordDictionary()` now serializes wrapped JSON and invokes Tauri command |
| `lib/word-dictionary.ts` | git add | Currently untracked |
| `app/page.tsx`, `components/veloce/settings-page.tsx`, `package.json`, `pnpm-lock.yaml`, `src-tauri/tauri.conf.json` | (out of scope) | Stash before commit, pop after — see apply task list |

### Code patches

**`python/audio_engine.py` finally block (L2328-2334):**

```python
finally:
    if stopping:
        pass
    elif recording:
        emit({"status": "listening"})
    elif transcription_queue.empty():
        # Drain complete and not in an active session — terminal status.
        emit({"status": "stopped"})
```

**`python/audio_engine.py` helpers + `apply_word_substitutions` (insert above L879, rewrite L879-892):**

```python
def _detect_case_style(word: str) -> str:
    if not word or not word[0].isalpha():
        return "as-is"
    if word.isupper() and len(word) > 1:
        return "upper"
    if word[0].isupper() and (len(word) == 1 or word[1:].islower()):
        return "title"
    if word.islower():
        return "lower"
    return "as-is"

def _apply_case_style(replacement: str, style: str) -> str:
    if style == "upper": return replacement.upper()
    if style == "title": return (replacement[0].upper() + replacement[1:]) if replacement else replacement
    if style == "lower": return replacement.lower()
    return replacement

def apply_word_substitutions(text: str) -> str:
    if not word_substitutions:
        return text
    PUNCT = '.,;:!?¡¿¿—\'"()[]{}'
    words = text.split()
    corrected = []
    for w in words:
        key = w.lower().strip(PUNCT)
        if key in word_substitutions:
            style = _detect_case_style(w)
            corrected.append(_apply_case_style(word_substitutions[key], style))
        else:
            corrected.append(w)
    return " ".join(corrected)
```

**`src-tauri/src/main.rs` new command (insert near `reload_word_dictionary` L478):**

```rust
fn get_dictionary_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("veloce")
        .join("word_dictionary.json")
}

#[tauri::command]
fn write_word_dictionary(state: tauri::State<AppState>, json: String) -> Result<(), String> {
    use std::fs;
    let final_path = get_dictionary_path();
    let tmp_path = final_path.with_extension("json.tmp");
    fs::create_dir_all(final_path.parent().unwrap())
        .map_err(|e| format!("create_dir_all failed: {e}"))?;
    fs::write(&tmp_path, json.as_bytes())
        .map_err(|e| format!("write tmp failed: {e}"))?;
    fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("rename failed: {e}"))?;
    engine::write_engine_command(&state, "RELOAD_DICT\n")
}
```

Add to `invoke_handler!` macro: `write_word_dictionary`. Add `use std::path::PathBuf;` to imports.

**`lib/word-dictionary.ts` `saveWordDictionary()` (L20-28):**

```typescript
export async function saveWordDictionary(subs: WordSub[]): Promise<void> {
  localStorage.setItem(DICT_KEY, JSON.stringify(subs));
  const json = JSON.stringify({ substitutions: subs });
  try {
    await safeInvoke("write_word_dictionary", { json });
  } catch (e) {
    console.error("Failed to write word dictionary to disk:", e);
    throw e;
  }
}
```

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Manual smoke | Bug 1 | Record 30s clip → STOP → widget returns to idle within 1s of drain complete (visual + log) |
| Manual smoke | Bug 2a | Add 3 subs in settings → save → quit Veloce → relaunch → check `~/.config/veloce/word_dictionary.json` exists with wrapped shape → speak, verify subs apply |
| Manual smoke | Bug 2b | Mapping `tauri → Tauri`. Speak "I use tauri and TAURI" → transcript shows "I use tauri and TAURI" (case preserved per occurrence, NOT both "Tauri") |
| Manual smoke | Bug 2b non-Latin | Mapping `hola → Hello`. Speak "東京に行った" → transcript unchanged |
| Unit (optional) | `_detect_case_style` | `assert _detect_case_style("TAURI")=="upper"`, `("Tauri")=="title"`, `("tauri")=="lower"`, `("tAuRi")=="as-is"`, `("東京")=="as-is"`, `("")=="as-is"` |

## Migration / Rollout

No data migration. Pre-existing in-memory `word_substitutions` and absent disk file are both valid (per spec, missing file = no-op). On first save after this change lands, the disk file is created atomically — no half-written state.

## Open Questions

- **Worker double-emission under timing races**: if `main_loop` pushes a transcription job *after* the worker's `queue.empty()` check, an extra `stopped` may fire on a later iteration. In practice `main_loop` only pushes while `recording=True`, and `recording=False` is set before `stopping=True` propagates to the worker. Acceptable; document in apply task.
- **`dirs` crate vs Tauri `app.path()`**: the prompt said "use the same `dirs` crate call pattern already in the codebase", but `dirs` is not yet a dependency. Adding it (1 line in Cargo.toml) is the simplest way to match the Python `get_dictionary_path()` across all 3 platforms.
- **Stash file list** at apply time must be re-validated against `git status` — the prompt listed `app/page.tsx`, `settings-page.tsx`, `package.json`, `pnpm-lock.yaml`, `tauri.conf.json` as out-of-scope M-files; `python/audio_engine.py` and `src-tauri/src/main.rs` are in-scope edits.
