# Changesets

Every change that should reach users gets a changeset: run `pnpm changeset`, pick the bump
(patch, minor, major) and write one line for the changelog. Commit the generated file with the
change. When changesets land on `main`, the release workflow opens a "Version packages" PR;
merging that PR publishes to npm.
