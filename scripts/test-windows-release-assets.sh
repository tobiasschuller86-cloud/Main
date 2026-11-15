#!/usr/bin/env bash
set -euo pipefail

verifier="$PWD/scripts/verify-windows-release-assets.sh"
test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT

installer_name="Tischtennis-Turnier-1.2.3-x64-unsigned.exe"
zip_name="Tischtennis-Turnier-1.2.3-x64-unsigned.zip"
installer_checksum_name="$installer_name.sha256"
zip_checksum_name="$zip_name.sha256"

write_mock_assets() {
  rm -f "$test_directory"/Tischtennis-Turnier-*
  printf 'mock Windows installer bytes\n' > "$test_directory/$installer_name"
  printf 'mock Windows ZIP bytes\n' > "$test_directory/$zip_name"
  (
    cd "$test_directory"
    sha256sum "$installer_name" > "$installer_checksum_name"
    sha256sum "$zip_name" > "$zip_checksum_name"
  )
}

verify_assets() {
  bash "$verifier" \
    "$test_directory" \
    "$installer_name" \
    "$zip_name" \
    "$installer_checksum_name" \
    "$zip_checksum_name" >/dev/null
}

assert_rejected() {
  local description="$1"
  if verify_assets >/dev/null 2>&1; then
    echo "$description was incorrectly accepted." >&2
    exit 1
  fi
  echo "Passed rejection check for $description."
}

write_mock_assets
printf 'unrelated release notes\n' > "$test_directory/release-notes.txt"
verify_assets
[[ "$(cat "$test_directory/release-notes.txt")" == "unrelated release notes" ]]
echo "Passed verification for both Windows assets and unrelated release files."

rm "$test_directory/$zip_name"
assert_rejected "a release missing its ZIP"

write_mock_assets
rm "$test_directory/$installer_checksum_name"
assert_rejected "a release missing its installer checksum"

write_mock_assets
rm "$test_directory/$zip_checksum_name"
assert_rejected "a release missing its ZIP checksum"

write_mock_assets
printf 'malformed checksum\n' > "$test_directory/$installer_checksum_name"
assert_rejected "a malformed installer checksum"

write_mock_assets
printf '%s  another-installer.exe\n' "$(sha256sum "$test_directory/$installer_name" | cut -d ' ' -f 1)" \
  > "$test_directory/$installer_checksum_name"
assert_rejected "an installer checksum naming a different file"

write_mock_assets
printf '%s  another-build.zip\n' "$(sha256sum "$test_directory/$zip_name" | cut -d ' ' -f 1)" \
  > "$test_directory/$zip_checksum_name"
assert_rejected "a ZIP checksum naming a different file"

write_mock_assets
printf 'altered installer bytes\n' > "$test_directory/$installer_name"
assert_rejected "altered installer bytes"

write_mock_assets
printf 'altered ZIP bytes\n' >> "$test_directory/$zip_name"
assert_rejected "altered ZIP bytes"

write_mock_assets
printf 'obsolete Windows ZIP\n' > "$test_directory/Tischtennis-Turnier-1.0.0-x64-signed.zip"
assert_rejected "an obsolete Windows build asset"

write_mock_assets
printf 'malformed checksum\nextra line\n' > "$test_directory/$zip_checksum_name"
assert_rejected "a multi-line ZIP checksum"
