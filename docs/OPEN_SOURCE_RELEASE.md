# Open-source release checklist

This repository is prepared for a public GitHub release, but publishing should
wait until each owner-controlled item below is complete.

## Required owner decisions

- [ ] Select and add a license. This is intentionally not guessed: MIT is
  permissive and simple; Apache-2.0 additionally provides an explicit patent
  grant; GPL-3.0 requires derivative distribution under the same license.
- [ ] Confirm the GitHub organization/account, repository name, and public
  description. Then add the matching `repository`, `homepage`, and `bugs` URLs
  to `package.json`.
- [ ] Confirm who will receive private security reports and conduct concerns.

## Repository settings after creation

- [ ] Create the GitHub repository as public and push `main` only after the
  license is present.
- [ ] Enable private vulnerability reporting.
- [ ] Protect `main`: require the `CI / Node 20` check, require a pull request,
  and restrict force pushes/deletions.
- [ ] Enable Dependabot alerts and the included GitHub Actions update schedule.
- [ ] Add repository topics such as `claude-code`, `bedrock`, `finops`,
  `developer-tools`, `privacy`, and `mcp`.
- [ ] Verify the public repository contains no `dist/`, `.tgz`, local index, or
  generated dashboard output. `.gitignore` already excludes release artifacts.

## First release

- [ ] Run `npm run release-check` locally.
- [ ] Review the generated package file list; it should contain only source,
  docs, and approved scripts.
- [ ] Commit, tag `v0.4.1`, and push the tag after CI is green.
- [ ] Run the manually triggered **Prepare GitHub release** workflow. It checks
  that the tag equals `package.json`, reruns the release gate, bundles the
  tarball, and attaches it to the GitHub release.

The release workflow never publishes to npm. `package.json` remains `private`
to prevent accidental registry publication.
