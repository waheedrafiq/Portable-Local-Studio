#!/usr/bin/env bash
# Source-only helpers. No network or installation work happens when sourced.
# Keep expected hashes in the reviewed manifest, not in runtime-fetched metadata.

expected_download_sha256() {
  local url="$1" manifest expected
  manifest="$(dirname "${BASH_SOURCE[0]}")/linux-downloads.sha256"
  expected="$(awk -v url="$url" '
    /^[[:space:]]*#/ || NF == 0 { next }
    $2 == url { count++; hash = $1; if (NF != 2) invalid = 1 }
    END { if (count != 1 || invalid) exit 1; print hash }
  ' "$manifest")" || {
    echo "No unique reviewed SHA-256 for $url; refusing download. See docs/linux-download-audit.md." >&2
    return 1
  }
  if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Invalid reviewed SHA-256 for $url; refusing download." >&2
    return 1
  fi
  printf '%s\n' "$expected"
}

verify_download_sha256() {
  local file="$1" expected="$2" actual
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum < "$file")" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 < "$file")" || return 1
  else
    echo "SHA-256 verification requires sha256sum or shasum; refusing download." >&2
    return 1
  fi
  actual="${actual%% *}"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 mismatch for $file; refusing to install." >&2
    return 1
  fi
}

download_verified() {
  local url="$1" dest="$2" expected
  local partial="${dest}.part"
  # Explicit returns are required: callers may use this function in if/&& lists.
  rm -f "$partial" || return 1
  [[ "$url" == https://* ]] || return 1
  expected="$(expected_download_sha256 "$url")" || return 1
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    echo "SHA-256 verification requires sha256sum or shasum; refusing download." >&2
    return 1
  fi
  if ! curl --disable --fail --show-error --location --proto '=https' --proto-redir '=https' \
      --progress-bar "$url" -o "$partial"; then
    rm -f "$partial"
    return 1
  fi
  if ! verify_download_sha256 "$partial" "$expected"; then
    rm -f "$partial"
    return 1
  fi
  mv "$partial" "$dest" || { rm -f "$partial"; return 1; }
}
