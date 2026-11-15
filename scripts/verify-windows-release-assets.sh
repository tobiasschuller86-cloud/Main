#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 <asset-directory> <installer> <zip> <installer-checksum> <zip-checksum>" >&2
  exit 2
fi

asset_directory="$1"
installer_name="$2"
zip_name="$3"
installer_checksum_name="$4"
zip_checksum_name="$5"
if [[ "$installer_checksum_name" != "$installer_name.sha256" ]]; then
  echo "The published Windows installer checksum has an unexpected filename: $installer_checksum_name" >&2
  exit 1
fi
if [[ "$zip_checksum_name" != "$zip_name.sha256" ]]; then
  echo "The published Windows ZIP checksum has an unexpected filename: $zip_checksum_name" >&2
  exit 1
fi
expected_assets=(
  "$installer_name"
  "$zip_name"
  "$installer_checksum_name"
  "$zip_checksum_name"
)

for asset in "${expected_assets[@]}"; do
  if [[ ! -f "$asset_directory/$asset" ]]; then
    echo "The published Windows release is missing asset: $asset" >&2
    exit 1
  fi
done

for candidate in "$asset_directory"/Tischtennis-Turnier-*-x64*; do
  [[ -f "$candidate" ]] || continue
  candidate_name="$(basename "$candidate")"
  if [[ "$candidate_name" =~ ^Tischtennis-Turnier-.*-x64.*\.(exe|zip)(\.sha256)?$ ]]; then
    is_expected=false
    for expected in "${expected_assets[@]}"; do
      if [[ "$candidate_name" == "$expected" ]]; then
        is_expected=true
        break
      fi
    done
    if [[ "$is_expected" != true ]]; then
      echo "The published Windows release contains an unexpected or obsolete Windows asset: $candidate_name" >&2
      exit 1
    fi
  fi
done

verify_checksum_sidecar() {
  local checksum_name="$1"
  local expected_name="$2"
  local checksum_path="$asset_directory/$checksum_name"
  local -a lines=()
  mapfile -t lines < "$checksum_path"

  if [[ ${#lines[@]} -ne 1 || ! "${lines[0]}" =~ ^([[:xdigit:]]{64})\ \ (.+)$ ]]; then
    echo "The published Windows release checksum has an invalid format: $checksum_name" >&2
    return 1
  fi
  if [[ "${BASH_REMATCH[2]}" != "$expected_name" ]]; then
    echo "The published Windows release checksum names a different file: $checksum_name" >&2
    return 1
  fi
}

verify_checksum_sidecar "$installer_checksum_name" "$installer_name"
verify_checksum_sidecar "$zip_checksum_name" "$zip_name"

(
  cd "$asset_directory"
  sha256sum --check --strict "$installer_checksum_name" "$zip_checksum_name"
)
