#!/usr/bin/env bash
set -euo pipefail

repo_root="$PWD"
test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT
mock_bin="$test_directory/bin"
state_directory="$test_directory/release"
input_directory="$test_directory/current"
mkdir -p "$mock_bin" "$state_directory/files" "$input_directory"

cat > "$mock_bin/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -euo pipefail
state="$GH_MOCK_STATE"
assets_file="$state/assets.tsv"
files_directory="$state/files"

if [[ "$1" == release && "$2" == upload ]]; then
  shift 2
  tag="$1"
  file="$2"
  upload_count_file="$state/upload-count"
  count=0
  [[ -f "$upload_count_file" ]] && count="$(cat "$upload_count_file")"
  count=$((count + 1))
  printf '%s' "$count" > "$upload_count_file"
  if [[ "${GH_MOCK_FAIL_UPLOAD_AT:-}" == "$count" ]]; then
    echo "simulated upload interruption" >&2
    exit 1
  fi

  name="$(basename "$file")"
  temporary_assets="$state/assets.tmp"
  awk -F '\t' -v name="$name" '$2 != name' "$assets_file" > "$temporary_assets"
  mv "$temporary_assets" "$assets_file"
  next_id="$(cat "$state/next-id")"
  printf '%s\t%s\n' "$next_id" "$name" >> "$assets_file"
  printf '%s' "$((next_id + 1))" > "$state/next-id"
  cp "$file" "$files_directory/$name"
  exit 0
fi

if [[ "$1" == api ]]; then
  shift
  method="GET"
  if [[ "$1" == --paginate ]]; then shift; fi
  if [[ "$1" == --method ]]; then
    method="$2"
    shift 2
  fi
  endpoint="$1"
  shift

  if [[ "$endpoint" == repos/*/releases/tags/* ]]; then
    printf '123\n'
    exit 0
  fi
  if [[ "$endpoint" == */assets ]]; then
    cat "$assets_file"
    exit 0
  fi
  if [[ "$endpoint" == */assets/* ]]; then
    asset_id="${endpoint##*/}"
    if [[ "$method" == DELETE ]]; then
      name="$(awk -F '\t' -v id="$asset_id" '$1 == id { print $2 }' "$assets_file")"
      if [[ -z "$name" ]]; then
        echo "missing mock asset $asset_id" >&2
        exit 1
      fi
      temporary_assets="$state/assets.tmp"
      awk -F '\t' -v id="$asset_id" '$1 != id' "$assets_file" > "$temporary_assets"
      mv "$temporary_assets" "$assets_file"
      rm -f "$files_directory/$name"
      exit 0
    fi
    name="$(awk -F '\t' -v id="$asset_id" '$1 == id { print $2 }' "$assets_file")"
    if [[ -z "$name" || ! -f "$files_directory/$name" ]]; then
      echo "missing mock asset $asset_id" >&2
      exit 1
    fi
    cat "$files_directory/$name"
    exit 0
  fi
fi

echo "Unexpected mock gh invocation: $*" >&2
exit 2
MOCK_GH
chmod +x "$mock_bin/gh"

printf '10' > "$state_directory/next-id"
: > "$state_directory/upload-count"
: > "$state_directory/assets.tsv"
old_installer="Tischtennis-Turnier-1.0.0-x64-unsigned.exe"
old_zip="Tischtennis-Turnier-1.0.0-x64-unsigned.zip"
printf 'previous installer\n' > "$state_directory/files/$old_installer"
printf 'previous ZIP\n' > "$state_directory/files/$old_zip"
(
  cd "$state_directory/files"
  sha256sum "$old_installer" > "$old_installer.sha256"
  sha256sum "$old_zip" > "$old_zip.sha256"
)
printf 'release notes\n' > "$state_directory/files/release-notes.txt"
printf 'unrelated guide\n' > "$state_directory/files/Tischtennis-Turnier-desktop-guide.pdf"
id=1
for name in \
  "$old_installer" \
  "$old_zip" \
  "$old_installer.sha256" \
  "$old_zip.sha256" \
  release-notes.txt \
  Tischtennis-Turnier-desktop-guide.pdf; do
  printf '%s\t%s\n' "$id" "$name" >> "$state_directory/assets.tsv"
  id=$((id + 1))
done
printf '%s' "$id" > "$state_directory/next-id"

new_installer="Tischtennis-Turnier-2.0.0-x64-unsigned.exe"
new_zip="Tischtennis-Turnier-2.0.0-x64-unsigned.zip"
printf 'new installer\n' > "$input_directory/$new_installer"
printf 'new ZIP\n' > "$input_directory/$new_zip"
(
  cd "$input_directory"
  sha256sum "$new_installer" > "$new_installer.sha256"
  sha256sum "$new_zip" > "$new_zip.sha256"
)

run_publish() {
  GH_MOCK_STATE="$state_directory" \
    GITHUB_REPOSITORY="test-owner/test-repo" \
    PATH="$mock_bin:$PATH" \
    GH_MOCK_FAIL_UPLOAD_AT="${GH_MOCK_FAIL_UPLOAD_AT:-}" \
    bash "$repo_root/scripts/publish-windows-release-assets.sh" v2.0.0 "$input_directory"
}

if GH_MOCK_FAIL_UPLOAD_AT=3 run_publish > "$test_directory/failed-upload.log" 2>&1; then
  echo "The simulated partial release upload unexpectedly succeeded." >&2
  exit 1
fi
for name in \
  "$old_installer" \
  "$old_zip" \
  "$old_installer.sha256" \
  "$old_zip.sha256"; do
  grep -Fq $'\t'"$name" "$state_directory/assets.tsv" || {
    echo "The failed upload did not restore the previous release asset: $name" >&2
    exit 1
  }
  [[ -f "$state_directory/files/$name" ]]
done
[[ "$(cat "$state_directory/files/$old_installer")" == "previous installer" ]]
[[ "$(cat "$state_directory/files/$old_zip")" == "previous ZIP" ]]
[[ "$(cat "$state_directory/files/release-notes.txt")" == "release notes" ]]
[[ "$(cat "$state_directory/files/Tischtennis-Turnier-desktop-guide.pdf")" == "unrelated guide" ]]
if grep -Fq "$new_installer" "$state_directory/assets.tsv"; then
  echo "A partial new Windows asset remained after rollback." >&2
  exit 1
fi
grep -q "Restored the previous Windows release asset set." "$test_directory/failed-upload.log"
echo "Passed rollback check after a partial Windows release upload."

run_publish > "$test_directory/successful-upload.log" 2>&1
for name in \
  "$new_installer" \
  "$new_zip" \
  "$new_installer.sha256" \
  "$new_zip.sha256"; do
  grep -Fq $'\t'"$name" "$state_directory/assets.tsv" || {
    echo "The retry did not publish the complete Windows asset: $name" >&2
    exit 1
  }
done
if grep -Fq "$old_installer" "$state_directory/assets.tsv"; then
  echo "The successful retry retained an obsolete Windows build." >&2
  exit 1
fi
[[ "$(cat "$state_directory/files/release-notes.txt")" == "release notes" ]]
[[ "$(cat "$state_directory/files/Tischtennis-Turnier-desktop-guide.pdf")" == "unrelated guide" ]]
grep -q "Published and verified the complete Windows release asset set." "$test_directory/successful-upload.log"
echo "Passed retry, stale Windows asset cleanup, and unrelated asset preservation."

unexpected_name="Tischtennis-Turnier-2.0.0-x64-portable.exe"
printf 'unexpected Windows asset\n' > "$state_directory/files/$unexpected_name"
printf '%s\t%s\n' "$(cat "$state_directory/next-id")" "$unexpected_name" >> "$state_directory/assets.tsv"
if run_publish > "$test_directory/unexpected-asset.log" 2>&1; then
  echo "An unexpected Windows release asset was incorrectly accepted." >&2
  exit 1
fi
grep -q "unexpected Windows build asset" "$test_directory/unexpected-asset.log"
grep -Fq $'\t'"$new_installer" "$state_directory/assets.tsv"
[[ "$(cat "$state_directory/files/release-notes.txt")" == "release notes" ]]
echo "Passed rejection check for unexpected Windows release assets."
