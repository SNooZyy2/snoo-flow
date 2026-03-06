#!/bin/bash
# Pre-commit check: run hook settings tests if any hook files are staged.
# Install: ln -sf ../../scripts/pre-commit-hooks-check.sh .git/hooks/pre-commit

STAGED=$(git diff --cached --name-only)

if echo "$STAGED" | grep -qE '\.claude/(settings\.json|hooks/)'; then
  echo "[pre-commit] Hook files changed — running hook settings tests..."
  npx tsx --test tests/hooks-settings.test.js 2>&1
  if [ $? -ne 0 ]; then
    echo "[pre-commit] Hook settings tests FAILED. Fix before committing."
    exit 1
  fi
  echo "[pre-commit] Hook settings tests passed."
fi
