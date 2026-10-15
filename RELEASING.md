# Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets) and
`.github/workflows/release.yml`. Nobody publishes from a laptop.

## Day to day

1. A change that users should see gets a changeset: `pnpm changeset`, choose patch, minor or major,
   write one line. Commit the generated `.changeset/*.md` file with the change.
2. When it merges to `main`, the release workflow runs the full checks, then opens or updates a
   **chore: version packages** PR with the new version and `CHANGELOG.md`.
3. Merging that PR publishes to npm (with provenance), tags the release and creates the GitHub
   release.

## One-time setup

- **Repo setting:** Settings → Actions → General → "Allow GitHub Actions to create and approve pull
  requests".
- **`RELEASE_TOKEN` (secret):** a fine-grained personal access token limited to this repo with
  Contents and Pull requests set to read and write. Pull requests opened with the default
  `GITHUB_TOKEN` do not start CI, so without this token the version PR could never pass the required
  checks. When it expires, regenerate it.
- **First publish only: `NPM_TOKEN` (secret).** A granular npm access token limited to publishing the
  `steady-socket` package, with a short expiry. The package does not exist on npm yet, so there is
  nothing to attach a trusted publisher to. The first release publishes with this token and still
  gets provenance.
- **After 0.1.0 is on npm:** on npmjs.com open the package → Settings → Trusted Publisher → GitHub
  Actions, and enter this repository (`lalmachado/steady-socket`) and the workflow file name
  `release.yml`. Then delete the `NPM_TOKEN` secret and revoke the token on npm. Later releases
  authenticate with OIDC alone, so no npm credential is stored in GitHub.
