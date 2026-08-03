#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo 'public audit needs ripgrep (rg): brew install ripgrep, or apt install ripgrep.' >&2
  exit 1
fi

# Checks the candidate public tree, including untracked non-ignored files before
# the initial commit. Output deliberately contains only a file path on failure.
if git ls-files --cached --others --exclude-standard | rg -n '(^|/)(\.env|index\.json|.*\.jsonl|.*\.tgz)$|(^|/)dist/' >/dev/null; then
  echo 'public audit failed: candidate public tree contains local data or release artifacts' >&2
  exit 1
fi

# --hidden is required: without it ripgrep skips every dotfile, so a credential
# in .env, .npmrc, or .claude/ would never be scanned. `.git` is excluded both
# as a directory and as a plain file, because in a worktree it is a file holding
# an absolute gitdir path.
if rg -l --hidden -g '!.git' -g '!.git/**' -g '!dist/**' -e 'AKIA[0-9A-Z]{16}' -e 'ghp_[A-Za-z0-9]{30,}' -e 'github_pat_[A-Za-z0-9_]+' -e 'xox[baprs]-[A-Za-z0-9-]+' -e '-----BEGIN [A-Z ]+PRIVATE KEY-----' . >/dev/null; then
  echo 'public audit failed: candidate tree appears to contain a credential or private key' >&2
  exit 1
fi

if rg -l --hidden -g '!.git' -g '!.git/**' -g '!dist/**' -e '/Users/[A-Za-z0-9._-]+' -e 'C:\\Users\\' . >/dev/null; then
  echo 'public audit failed: candidate tree contains an absolute user-home path' >&2
  exit 1
fi

# A clean latest tree is not enough: every origin branch and tag becomes part of
# the public Git object graph. HEAD is included explicitly so this also covers a
# not-yet-pushed preparation commit. CI uses a full checkout for this scan.
while IFS= read -r revision; do
  if git grep -I -q -E 'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|-----BEGIN [A-Z ]+PRIVATE KEY-----' "$revision" -- .; then
    echo 'public audit failed: reachable Git history appears to contain a credential or private key' >&2
    exit 1
  fi
  if git grep -I -q -E '/Users/[A-Za-z0-9._-]+|C:\\Users\\' "$revision" -- .; then
    echo 'public audit failed: reachable Git history contains an absolute user-home path' >&2
    exit 1
  fi
done < <(git rev-list HEAD --remotes=origin --tags)

echo 'public audit passed: no candidate or historical local data, release artifacts, credentials, private keys, or user-home paths'
