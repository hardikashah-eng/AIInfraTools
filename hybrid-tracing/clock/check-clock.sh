#!/usr/bin/env bash
# Checks that this machine's clock is synchronised closely enough for cross-site tracing.
#
#   check-clock.sh [--max-error-ms 1] [--textfile /var/lib/node_exporter/textfile/clock.prom] [--site onprem]
#
# Reads `chronyc -c tracking` and computes chrony's own bound on the clock error:
#   |system time offset| + root dispersion + root delay / 2
# Exits 0 when synchronised and within the bound, 1 when synchronised but outside it, 2 when not synchronised or
# chrony is unreachable. Use it as a Kubernetes readiness probe, a cron check, or a node_exporter textfile source.
# CHRONYC overrides the chronyc binary (used by the tests).
set -u
max_ms=1
textfile=""
site="${SITE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --max-error-ms) max_ms="$2"; shift 2 ;;
    --textfile) textfile="$2"; shift 2 ;;
    --site) site="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
chronyc="${CHRONYC:-chronyc}"
host="$(hostname 2>/dev/null || echo unknown)"

emit() { # synced offset_s error_s stratum
  local out
  out=$(cat <<EOF
# HELP clock_synchronized 1 if chrony reports a synchronised clock.
# TYPE clock_synchronized gauge
clock_synchronized{host="$host",site="$site"} $1
# HELP clock_offset_seconds System clock offset from chrony's reference, as chronyc reports it.
# TYPE clock_offset_seconds gauge
clock_offset_seconds{host="$host",site="$site"} $2
# HELP clock_max_error_seconds Bound on the clock error: |offset| + root dispersion + root delay / 2.
# TYPE clock_max_error_seconds gauge
clock_max_error_seconds{host="$host",site="$site"} $3
# HELP clock_stratum NTP stratum of this clock.
# TYPE clock_stratum gauge
clock_stratum{host="$host",site="$site"} $4
EOF
)
  if [ -n "$textfile" ]; then printf '%s\n' "$out" > "$textfile.tmp" && mv "$textfile.tmp" "$textfile"; else printf '%s\n' "$out"; fi
}

if ! line="$("$chronyc" -c tracking 2>/dev/null)" || [ -z "$line" ]; then
  echo "chrony is not reachable" >&2; emit 0 0 0 0; exit 2
fi
# CSV fields: 1 ref id, 2 ref name, 3 stratum, 4 ref time, 5 system time offset, 6 last offset, 7 rms offset,
# 8 frequency, 9 residual freq, 10 skew, 11 root delay, 12 root dispersion, 13 update interval, 14 leap status
IFS=',' read -r _ ref stratum _ systime _ _ _ _ _ rdelay rdisp _ leap <<<"$line"
leap="${leap//$'\r'/}"
read -r err ok <<<"$(awk -v o="$systime" -v d="$rdelay" -v p="$rdisp" -v m="$max_ms" 'BEGIN { if (o < 0) o = -o; e = o + p + d / 2; printf "%.9f %d\n", e, (e <= m / 1000) }')"
if [ "$leap" = "Not synchronised" ] || [ "${stratum:-0}" = "0" ]; then
  echo "clock not synchronised (reference: ${ref:-none})" >&2; emit 0 "$systime" "$err" "${stratum:-0}"; exit 2
fi
emit 1 "$systime" "$err" "$stratum"
if [ "$ok" = "1" ]; then exit 0; fi
echo "clock error bound ${err}s exceeds ${max_ms} ms (reference: $ref, stratum $stratum)" >&2
exit 1
