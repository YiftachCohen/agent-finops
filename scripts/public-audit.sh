#!/usr/bin/env bash
set -euo pipefail

# Checks the candidate public tree, including untracked non-ignored files before
# the initial commit. Output deliberately contains only a file path on failure.
if git ls-files --cached --others --exclude-standard | rg -n '(^|/)(\.env|index\.json|.*\.jsonl|.*\.tgz)$|(^|/)dist/' >/dev/null; then
  echo 'public audit failed: candidate public tree contains local data or release artifacts' >&2
  exit 1
fi

if rg -l -g '!.git/**' -g '!dist/**' -e 'AKIA[0-9A-Z]{16}' -e 'ghp_[A-Za-z0-9]{30,}' -e 'github_pat_[A-Za-z0-9_]+' -e 'xox[baprs]-[A-Za-z0-9-]+' -e '-----BEGIN [A-Z ]+PRIVATE KEY-----' . >/dev/null; then
  echo 'public audit failed: candidate tree appears to contain a credential or private key' >&2
  exit 1
fi

if rg -l -g '!.git/**' -g '!dist/**' -e '/Users/[A-Za-z0-9._-]+' -e 'C:\\Users\\' . >/dev/null; then
  echo 'public audit failed: candidate tree contains an absolute user-home path' >&2
  exit 1
fi

echo 'public audit passed: no candidate local data, release artifacts, credentials, private keys, or user-home paths'
