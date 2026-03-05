import sys
import os

path = "python/audio_engine.py"
print(f"Patching {path}...")

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Add Logging to return
target_log = """    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate

    return None"""

replacement_log = """    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            emit({"log": f"Found whispercpp at: {candidate}"})
            return candidate

    emit({"error": f"Could not find whisper-cli.exe. Searched {len(candidates)} locations."})
    emit({"log": f"Search paths included: {[str(c) for c in candidates]}"})
    return None"""

if target_log in content:
    content = content.replace(target_log, replacement_log)
    print("Applied logging patch.")
else:
    print("Logging target not found!")
    # Debug: print surrounding lines?
    pass

# 2. Add Sibling Candidate
target_list = """            exe_path.parent / "resources" / "whispercpp" / f"whisper-cli{ext}",
        ]"""

replacement_list = """            exe_path.parent / "resources" / "whispercpp" / f"whisper-cli{ext}",
            exe_path / f"whisper-cli{ext}", # Sibling check
            exe_path / "whisper-cli.exe", 
        ]"""

if target_list in content:
    content = content.replace(target_list, replacement_list)
    print("Applied candidates patch.")
else:
    print("Candidates target not found!")

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("Done.")
