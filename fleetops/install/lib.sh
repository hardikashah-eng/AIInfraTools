# Shared by the installers: tokens minted with openssl and hashed with SHA-256, exactly as `fleetops token create`.
mint_token() { printf 'fo_%s' "$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')"; }
sha256_hex() { if command -v sha256sum >/dev/null; then printf '%s' "$1" | sha256sum | cut -d' ' -f1; else printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; fi; }
# write_tokens JSONL_OUT PLAIN_OUT: admin (admin, all), collector (ingest), grafana (read, infra)
write_tokens() {
  local jsonl="$1" plain="$2" spec name role scope t tenant
  command -v openssl >/dev/null || { echo "error: openssl is required to make tokens" >&2; return 1; }
  ( umask 077; : > "$jsonl"; : > "$plain"
    for spec in "admin:admin:*" "collector:ingest:*" "grafana:read:infra"; do
      IFS=: read -r name role scope <<<"$spec"; t=$(mint_token); tenant='"*"'; [ "$scope" = infra ] && tenant='{"infra":true}'
      printf '{"name":"%s","sha256":"%s","roles":["%s"],"tenant":%s}\n' "$name" "$(sha256_hex "$t")" "$role" "$tenant" >> "$jsonl"
      printf '%s=%s\n' "$name" "$t" >> "$plain"
    done )
}
