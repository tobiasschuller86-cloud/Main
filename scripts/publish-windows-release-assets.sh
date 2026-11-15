#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <release-tag> <asset-directory>" >&2
  exit 2
fi

release_tag="$1"
asset_directory="$2"
asset_directory="$(cd "$asset_directory" && pwd)"
installer_files=("$asset_directory"/Tischtennis-Turnier-*-x64-*.exe)
zip_files=("$asset_directory"/Tischtennis-Turnier-*-x64-*.zip)

if [[ ${#installer_files[@]} -ne 1 || ! -f "${installer_files[0]}" ]]; then
  echo "Expected exactly one Windows installer, found ${#installer_files[@]}." >&2
  exit 1
fi
if [[ ${#zip_files[@]} -ne 1 || ! -f "${zip_files[0]}" ]]; then
  echo "Expected exactly one Windows ZIP build, found ${#zip_files[@]}." >&2
  exit 1
fi

installer="${installer_files[0]}"
zip_build="${zip_files[0]}"
installer_name="$(basename "$installer")"
zip_name="$(basename "$zip_build")"
if [[ "${installer_name%.exe}" != "${zip_name%.zip}" ]]; then
  echo "The Windows installer and ZIP do not have matching version and signing labels." >&2
  exit 1
fi
installer_checksum_name="$installer_name.sha256"
zip_checksum_name="$zip_name.sha256"

bash "$(dirname "$0")/verify-windows-release-assets.sh" \
  "$asset_directory" \
  "$installer_name" \
  "$zip_name" \
  "$installer_checksum_name" \
  "$zip_checksum_name"

release_id="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$release_tag" --jq '.id')"
assets_endpoint="repos/$GITHUB_REPOSITORY/releases/$release_id/assets"
asset_endpoint="repos/$GITHUB_REPOSITORY/releases/assets"
temporary_directory="$(mktemp -d)"
backup_directory="$temporary_directory/previous"
verification_directory="$temporary_directory/verified"
mkdir -p "$backup_directory" "$verification_directory"
transaction_started=false

is_windows_candidate() {
  [[ "$1" =~ ^Tischtennis-Turnier-.*-x64.*\.(exe|zip)(\.sha256)?$ ]]
}

is_recognized_windows_asset() {
  [[ "$1" =~ ^Tischtennis-Turnier-.+-x64(-(signed|unsigned))?\.(exe|zip)(\.sha256)?$ ]]
}

load_release_assets() {
  local rows
  rows="$(gh api --paginate "$assets_endpoint" --jq '.[] | [.id, .name] | @tsv')"
  RELEASE_ASSETS=()
  if [[ -n "$rows" ]]; then
    mapfile -t RELEASE_ASSETS <<< "$rows"
  fi
}

asset_id_for_name() {
  local wanted_name="$1"
  local row asset_id asset_name
  for row in "${RELEASE_ASSETS[@]}"; do
    IFS=$'\t' read -r asset_id asset_name <<< "$row"
    if [[ "$asset_name" == "$wanted_name" ]]; then
      printf '%s' "$asset_id"
      return 0
    fi
  done
  return 1
}

download_asset() {
  local asset_id="$1"
  local destination="$2"
  gh api "$asset_endpoint/$asset_id" -H "Accept: application/octet-stream" > "$destination"
}

rollback_release_assets() {
  local rollback_failed=false
  local row asset_id asset_name
  load_release_assets || rollback_failed=true
  if [[ "$rollback_failed" != true ]]; then
    for row in "${RELEASE_ASSETS[@]}"; do
      IFS=$'\t' read -r asset_id asset_name <<< "$row"
      if is_recognized_windows_asset "$asset_name"; then
        gh api --method DELETE "$asset_endpoint/$asset_id" || rollback_failed=true
      fi
    done
  fi

  local previous_asset
  for previous_asset in "$backup_directory"/*; do
    [[ -f "$previous_asset" ]] || continue
    gh release upload "$release_tag" "$previous_asset" --clobber || rollback_failed=true
  done

  if [[ "$rollback_failed" == true ]]; then
    echo "ERROR: Windows release publication failed and the previous asset set could not be fully restored. The release may be incomplete; repair the release assets before retrying." >&2
    return 1
  fi

  load_release_assets || return 1
  for previous_asset in "$backup_directory"/*; do
    [[ -f "$previous_asset" ]] || continue
    local previous_name
    previous_name="$(basename "$previous_asset")"
    asset_id="$(asset_id_for_name "$previous_name")" || {
      echo "ERROR: Rollback did not restore Windows release asset: $previous_name" >&2
      return 1
    }
    local restored_path="$verification_directory/$previous_name"
    download_asset "$asset_id" "$restored_path" || return 1
    if ! cmp -s "$previous_asset" "$restored_path"; then
      echo "ERROR: Rollback restored different bytes for Windows release asset: $previous_name" >&2
      return 1
    fi
  done
  echo "Restored the previous Windows release asset set." >&2
}

on_exit() {
  local exit_status=$?
  trap - EXIT
  if [[ "$transaction_started" == true ]]; then
    if ! rollback_release_assets; then
      exit_status=1
    fi
  fi
  rm -rf "$temporary_directory"
  exit "$exit_status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

load_release_assets
release_asset_rows=("${RELEASE_ASSETS[@]}")
for row in "${release_asset_rows[@]}"; do
  IFS=$'\t' read -r asset_id asset_name <<< "$row"
  [[ -n "$asset_name" ]] || continue
  if is_windows_candidate "$asset_name" && ! is_recognized_windows_asset "$asset_name"; then
    echo "The release contains an unexpected Windows build asset: $asset_name" >&2
    exit 1
  fi
  if is_recognized_windows_asset "$asset_name"; then
    if [[ "$asset_name" == */* || "$asset_name" == *$'\t'* ]]; then
      echo "The release contains an invalid Windows asset name: $asset_name" >&2
      exit 1
    fi
    download_asset "$asset_id" "$backup_directory/$asset_name"
  fi
done

transaction_started=true
for file in "$installer" "$zip_build" "$installer.sha256" "$zip_build.sha256"; do
  gh release upload "$release_tag" "$file" --clobber
done

# Remove only previously recognized Windows build outputs. Other release
# assets, including unrelated Tischtennis-Turnier downloads, are untouched.
load_release_assets
for row in "${RELEASE_ASSETS[@]}"; do
  IFS=$'\t' read -r asset_id asset_name <<< "$row"
  [[ -n "$asset_name" ]] || continue
  if is_recognized_windows_asset "$asset_name" &&
    [[ "$asset_name" != "$installer_name" ]] &&
    [[ "$asset_name" != "$zip_name" ]] &&
    [[ "$asset_name" != "$installer_checksum_name" ]] &&
    [[ "$asset_name" != "$zip_checksum_name" ]]; then
    echo "Removing obsolete Windows release asset: $asset_name"
    gh api --method DELETE "$asset_endpoint/$asset_id"
  fi
done

load_release_assets
for asset_name in "$installer_name" "$zip_name" "$installer_checksum_name" "$zip_checksum_name"; do
  asset_id="$(asset_id_for_name "$asset_name")" || {
    echo "The published Windows release is missing asset: $asset_name" >&2
    exit 1
  }
  download_asset "$asset_id" "$verification_directory/$asset_name"
done

bash "$(dirname "$0")/verify-windows-release-assets.sh" \
  "$verification_directory" \
  "$installer_name" \
  "$zip_name" \
  "$installer_checksum_name" \
  "$zip_checksum_name"

for row in "${RELEASE_ASSETS[@]}"; do
  IFS=$'\t' read -r asset_id asset_name <<< "$row"
  if is_recognized_windows_asset "$asset_name" &&
    [[ "$asset_name" != "$installer_name" ]] &&
    [[ "$asset_name" != "$zip_name" ]] &&
    [[ "$asset_name" != "$installer_checksum_name" ]] &&
    [[ "$asset_name" != "$zip_checksum_name" ]]; then
    echo "The published Windows release still contains obsolete asset: $asset_name" >&2
    exit 1
  fi
done

transaction_started=false
echo "Published and verified the complete Windows release asset set."
