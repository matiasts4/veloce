#!/bin/bash
set -e

echo "=== Veloce macOS Test Runner ==="

# 1. Ensure Homebrew dependencies (Audio)
if ! command -v brew &> /dev/null; then
    echo "Warning: Homebrew not found. Skipping dependency checks."
else
    echo "Checking libraries..."
    brew install portaudio || true
fi

# 2. Run Python Automation
echo "Running Python Test Suite..."
python3 tests/runners/run_local_test.py
