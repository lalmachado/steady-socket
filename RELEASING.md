# Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets) and
`.github/workflows/release.yml`. Nobody publishes from a laptop, and no npm token is stored in GitHub.

## Day to day

1. A change that users should see gets a changeset: `pnpm changeset`, choose patch, minor or major,
   write one line. Commit the generated `.changeset/*.md` file with the change.
2. When it merges to `main`, the release workflow runs the full checks, then opens or updates a
   **chore: version packages** PR with the new version and `CHANGELOG.md`.
3. Merging that PR publishes to npm with provenance, then `scripts/tag-release.sh` pushes the `v*`
   tag and creates the GitHub release, using that version's section of `CHANGELOG.md` as the note.

## How publishing is authorised

- **npm trusted publisher** (package settings on npmjs.com): `lalmachado/steady-socket`, workflow
  `release.yml`, no environment. Allowed actions: `npm publish` on, `npm dist-tag` off. The workflow
  has `id-token: write`, and npm exchanges that for a short-lived credential, so there is nothing to
  rotate. The workflow file name is part of the trust: renaming `release.yml` breaks publishing until
  the trusted publisher is updated to match.
- **`RELEASE_TOKEN` (GitHub secret):** a fine-grained personal access token limited to this repo with
  Contents and Pull requests set to read and write. Pull requests opened with the default
  `GITHUB_TOKEN` do not start CI, so without it the version PR could never pass the required checks.
  It expires: regenerate it and update the secret when it does.
- **Repo setting:** Settings → Actions → General → "Allow GitHub Actions to create and approve pull
  requests".

## Things to know

- **The tag and GitHub release come from `scripts/tag-release.sh`, not from the Changesets action.**
  The action did not push the tag or create the release for `0.1.0` or `0.1.1`; the likely cause is
  that the current Changesets CLI prints publish results in a format the action does not recognise.
  The script runs on every push to `main` and does nothing unless npm has the version in
  `package.json` and the repo lacks its tag or release, so it also catches up a release that was
  missed. It tags the commit that set the version, not necessarily `HEAD`. To re-run it without a
  new commit, use **Run workflow** on the Release workflow in the Actions tab.
- **npm held the first publish for approval** ("staged publishing"), because the package was new.
  `0.1.1`, published by the trusted publisher, was not held. If a release run is green but the new
  version is missing on npm, look for a pending release on npmjs.com and approve it; the tag and
  release step then skips until the version exists, and the manual re-run above creates them.
- **`NODE_AUTH_TOKEN` must stay unset in the workflow.** Setting it overrides the trusted-publisher
  login.
