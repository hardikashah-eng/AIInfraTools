# Clocks across on-prem and neocloud

## Why it matters for traces

A trace's timeline is assembled from timestamps taken on different machines. In practice:
- PTP-synced hosts in one on-prem site agree to well under a microsecond.
- Two hosts each following their own site's NTP can disagree by milliseconds.

Prefill → KV transfer → first decoded token typically takes tens of milliseconds, so a few milliseconds of disagreement is enough to put a decode span before the prefill that fed it, or to make a KV transfer look 3 ms slower than it was. Per-hop latency measured across sites is then wrong in exactly the place you're trying to look.

## One reference for both sites

The neocloud nodes follow the **on-prem time servers over the private link**. The provider's time source is configured only as a fallback, used if the link is down.

If each site follows its own reference, both may be accurate to the world yet still disagree with each other by the sum of their errors. A single reference removes that.

| Path | Typical agreement with the reference | What limits it |
| --- | --- | --- |
| On-prem, PTP with hardware timestamps | < 1 µs | Switch support (boundary/transparent clocks) |
| On-prem, NTP to on-prem servers, hardware timestamps | 10–50 µs | Queueing in the switches |
| Neocloud, NTP over the private link (`xleave`) | 50 µs – 1 ms | **Asymmetry** between the two directions of the WAN path |
| Neocloud, provider's own NTP | 0.1 – 10 ms vs on-prem | Two references with independent errors |

NTP assumes the outbound and return trips take equally long. If the path to on-prem is 0.9 ms and the path back is 0.7 ms, the client's clock settles 0.1 ms off, and nothing in the timestamps reveals it. The same is true of the trace-side correction. To find it, measure once with a PPS/GNSS-disciplined clock in the neocloud, if the provider offers one, and set it as an `offset` on the server lines.

## The three files

- **`onprem-timeserver.chrony.conf`** (two or more servers):
  - Reference: the NIC's hardware clock (`refclock PHC`), disciplined by `ptp4l` from the grandmaster.
  - Serves NTP to on-prem and neocloud CIDRs, with `hwtimestamp *`.
  - `local stratum 8 orphan`: if every upstream is lost, the time servers agree on a held-over time instead of splitting.
  - NTS (authenticated NTP) is ready to enable for the cross-provider link.
- **`onprem-node.chrony.conf`:** PHC when the node runs `ptp4l`, otherwise the on-prem time servers in interleaved mode.
- **`neocloud-node.chrony.conf`:**
  - The on-prem time servers (`prefer`, `xleave`), with the provider as fallback.
  - `maxdistance 0.005` refuses any source whose error bound exceeds 5 ms.

All three step the clock only at start (`makestep 0.1 3`) and slew afterwards, so a span never sees time jump backwards.

## When you can't touch the neocloud node OS

Many neocloud Kubernetes offerings allow privileged DaemonSets but not node configuration. `deploy/chrony-daemonset.yaml` runs chrony with `hostNetwork` and `SYS_TIME`, which sets the node clock from a pod.

**Do not** run it on nodes that already have `chronyd`, `ntpd` or `systemd-timesyncd` active: two daemons disciplining one clock make it worse. Disable the host daemon first, or don't deploy the DaemonSet there.

If you can do neither, layer 3 (the skew-corrector) still corrects the traces. The clocks themselves stay off, though, so logs and metrics from those nodes are still skewed.

## Watching it

- **Readiness:** `clock/check-clock.sh` computes chrony's own error bound, `|offset| + root dispersion + root delay / 2`.
  - It exits 1 above `--max-error-ms` (default 1) and 2 when not synchronised.
  - Use it as the DaemonSet's readiness probe, from cron, or with `--textfile` for node_exporter.
  - Alert on `clock_synchronized == 0` and `clock_max_error_seconds > 0.001`.
- **Collector agent:** the `ntp` receiver records `ntp.offset` for every node against the shared time server, every 30 minutes (its minimum interval).
- **Skew-corrector:** exports `clock_skew_offset_seconds{domain,site}`. A neocloud host whose estimated offset drifts upward over hours has lost its time source. If the before/after violation counters both rise, a new host has appeared that no exchange reaches yet.

## What the correction can and cannot do

- **Can:** shift each host's spans by a constant offset learned from that host's own calls. Accuracy is as good as the best round trip allows: microseconds on-prem, and half the path asymmetry across the WAN.
- **Cannot:**
  - correct drift within a window (offsets are re-solved every 30 s, which is enough for a disciplined clock);
  - see path asymmetry;
  - place a host that never calls, or is never called by, an anchored host. Such a host is reported as `none` or `unanchored` and left as recorded.
- **Does not:** correct hosts in the reference site below the error of their own estimate. If PTP is working there, those shifts are a microsecond or two and harmless; set `--min-correction-ns` to skip them.
