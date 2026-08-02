# Open-source release checklist

This repository is prepared for a public GitHub release. Keep the repository
private until the code preparation is merged and every owner-controlled check
below is complete.

## Merge the preparation PR

- [ ] Confirm the root `LICENSE` is MIT and `package.json` declares `MIT` plus
  the public repository, homepage, and issue URLs.
- [ ] Confirm the README quickstart works from a fresh clone and the published
  pricing sources have a current verification date.
- [ ] Run `npm run release-check` and review the package file list. It must
  contain only the license, source, documentation, artwork, and approved
  scripts.
- [ ] Merge the preparation PR into `main` while the repository is still
  private.

`package.json` remains `private` intentionally. Open source does not require an
npm release, and the flag prevents accidental registry publication.

## Review everything visibility will expose

- [ ] Review every branch and tag that will remain on the remote. Delete stale
  release and Dependabot branches if they are no longer useful.
- [ ] Confirm the author and committer email addresses in public Git history
  are intentional. A `.mailmap` changes display output but does not remove an
  address from the underlying Git objects.
- [ ] Review existing pull requests, workflow logs, releases, and release
  assets. GitHub makes Actions history and logs visible with the repository.
- [ ] Run `npm run public-audit`. It checks the candidate tree; separately scan
  the reachable Git history because removing a secret from the latest tree does
  not remove it from old commits.

## Recreate the first public release

The existing private `v0.5.0` release was built before the license existed and
has no downloads. Replace it before changing repository visibility so the first
public source tag and tarball both contain the license:

1. Delete the private `v0.5.0` GitHub release and its tag.
2. Tag the merged preparation commit as `v0.5.0` and push the tag.
3. Run the manually triggered **Prepare GitHub release** workflow with
   `v0.5.0`. It verifies that the tag matches `package.json`, reruns the release
   gate, bundles the tarball, and attaches it to the GitHub release.
4. Inspect the release tarball and confirm it includes `LICENSE`.

Do not rewrite a release that anyone has downloaded. If that changes before
launch, publish the licensed tree as a new patch version instead.

## Make the repository public

- [ ] Set the description to: `Local-first cost analytics for Claude Code,
  without sending logs or source code anywhere.`
- [ ] Add topics: `claude-code`, `bedrock`, `finops`, `developer-tools`,
  `privacy`, and `mcp`.
- [ ] Change repository visibility to public.
- [ ] Enable GitHub Private Vulnerability Reporting, Dependabot alerts, secret
  scanning, and push protection.
- [ ] Protect `main`: require a pull request, require the Node 20, 22, and 24 CI
  checks, dismiss stale approvals, and restrict force pushes and deletions.
- [ ] Verify the security-report link, issue templates, clone instructions,
  release download, and fresh-clone installation from the public repository.
