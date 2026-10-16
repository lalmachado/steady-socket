# Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets) and
`.github/workflows/release.yml`. Nobody publishes from a laptop, and no npm token is stored in GitHub.

## Day to day

1. A change that users should see gets a changeset: `pnpm changeset`, choose patch, minor or major,
   write one line. Commit the generated `.changeset/*.md` file with the change.
2. When it merges to `main`, the release workflow runs the full checks, then opens or updates a
   **chore: version packages** PR with the new version and `CHANGELOG.md`.
3. Merging that PR publishes to npm with provenance and creates the `v*` tag. Check the GitHub
   release afterwards (see "Known gaps").

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

## Known gaps

- **npm held the first publish for approval** ("staged publishing"). `0.1.0` stayed a placeholder
  until it was approved on npmjs.com. It is not yet known whether later releases are held too; if a
  release run is green but the new version is missing on npm, look for a pending release there.
- **A new trusted publisher must be validated** by one successful publish within a few days of being
  created (npm shows "Pending validation").
- **The Changesets action did not push the tag or create the GitHub release** for `0.1.0`, which
  were created by hand. The likely cause is that the current Changesets CLI prints publish results
  in a format the action does not recognise. After each release, check that the tag and GitHub
  release exist.
