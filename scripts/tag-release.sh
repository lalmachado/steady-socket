#!/usr/bin/env bash
# Tags the commit that released the version in package.json and creates its GitHub release.
#
# Run by .github/workflows/release.yml after the Changesets step, which publishes to npm but, with
# the current Changesets CLI, does not push the tag or create the release (see RELEASING.md).
# Safe to run on every push to main: it does nothing unless npm has this version and the
# repository is missing its tag or release. Needs GH_TOKEN, plus `contents: write` to push.
set -euo pipefail

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
tag="v$version"

tag_on_remote() { git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; }
release_exists() { gh release view "$tag" >/dev/null 2>&1; }
package_version() { node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version"; }

if tag_on_remote && release_exists; then
  echo "$tag already has its tag and release."
  exit 0
fi

# Only release versions npm actually has: a publish may have failed or be waiting for approval.
# The registry can lag a few seconds behind a publish, so ask a few times.
published=""
for _ in 1 2 3 4 5 6; do
  published=$(npm view "$name@$version" version 2>/dev/null || true)
  [ "$published" = "$version" ] && break
  sleep "${REGISTRY_RETRY_SECONDS:-5}"
done
if [ "$published" != "$version" ]; then
  echo "$name@$version is not on npm (yet), so no tag and no release."
  exit 0
fi

# The commit that set package.json to this version, on main's first-parent history (the merge of
# the "version packages" PR). Not necessarily HEAD: this also catches up a release that was missed.
commit=""
while read -r candidate; do
  current=$(git show "$candidate:package.json" | package_version)
  before=$(git show "$candidate^1:package.json" 2>/dev/null | package_version || true)
  if [ "$current" = "$version" ] && [ "$before" != "$version" ]; then
    commit=$candidate
    break
  fi
done < <(git rev-list --first-parent HEAD -- package.json)
if [ -z "$commit" ]; then
  echo "Could not find the commit that set the version to $version." >&2
  exit 1
fi

if ! tag_on_remote; then
  # `changeset publish` may already have made the tag locally in this job.
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || git tag "$tag" "$commit"
  git push origin "refs/tags/$tag"
  echo "Pushed $tag ($(git rev-parse --short "$tag^{commit}"))."
fi

if ! release_exists; then
  flags=(--verify-tag --title "$tag")
  [[ "$version" == *-* ]] && flags+=(--prerelease)
  # The release note is this version's section of CHANGELOG.md.
  notes=$(mktemp)
  awk -v v="$version" '$0 == "## " v { found = 1; next } /^## / { found = 0 } found' CHANGELOG.md >"$notes"
  if [ -s "$notes" ]; then
    gh release create "$tag" "${flags[@]}" --notes-file "$notes"
  else
    gh release create "$tag" "${flags[@]}" --generate-notes
  fi
  echo "Created the GitHub release for $tag."
fi
