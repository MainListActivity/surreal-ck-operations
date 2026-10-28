#!/bin/sh
# SYS01 AC-B (review B2): a release directory is trusted for a commit only when its content is that commit's.
# The local switch (`company-service.sh install`) used to key everything on the directory *name*, so a directory named
# after a real commit but holding other content could be installed. This helper compares the release against the
# commit's archive.
#
# The comparison lists files only, on both sides, and skips the paths the release procedure adds after the archive
# (dependencies, generated vendor, build output, the service runtime dir). Listing files rather than diffing directories
# matters: a generated directory that holds only skipped files - `.runtime/`, for one - would otherwise show up as an
# "Only in" entry and refuse a release that is exactly its commit plus its prepared dependencies.
# Sourced by the scripts that switch a release; it reads no credentials.
#
# usage: . "$(dirname "$0")/release-content.sh"; release_matches_commit <release-dir> <commit-sha> <ops-repo>
release_matches_commit() {
  release=$1; sha=$2; repo=$3
  [ -d "$release" ] || return 1
  # A linked worktree has `.git` as a FILE (gitdir pointer), not a directory: `-e` accepts both, so the
  # release gate keeps working when it is run from a task worktree instead of the main checkout.
  [ -e "$repo/.git" ] || return 1
  work=$(mktemp -d) || return 1
  status=1
  if git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null \
    && git -C "$repo" archive --format=tar "$sha" > "$work/commit.tar" 2>/dev/null \
    && mkdir -p "$work/tree" \
    && tar -x -f "$work/commit.tar" -C "$work/tree" 2>/dev/null; then
    if command -v sha256sum >/dev/null 2>&1; then hasher=sha256sum; else hasher='shasum -a 256'; fi
    # One line per file: relative path, a space, the content digest. Sorted, so the two listings are comparable as text.
    manifest() {
      ( cd "$1" && find . -type f \
          -not -path './node_modules/*' -not -path '*/node_modules/*' \
          -not -path './plugin/server/vendor/*' \
          -not -path './vault/build/*' \
          -not -path './.runtime/*' \
          -not -path './.git/*' -print \
        | LC_ALL=C sort | while IFS= read -r path; do
            printf '%s %s\n' "$path" "$($hasher "$path" | cut -d' ' -f1)"
          done )
    }
    if manifest "$work/tree" > "$work/expected.txt" && manifest "$release" > "$work/actual.txt" \
      && cmp -s "$work/expected.txt" "$work/actual.txt"; then
      status=0
    fi
  fi
  rm -rf "$work"
  return $status
}
