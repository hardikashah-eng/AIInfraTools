# Real data used by the tests

These files are real measurements or real tool output, kept small so the tests run in CI without downloads. Each test
that uses them says what it checks.

| File | What it is | Source | License |
| --- | --- | --- | --- |
| `philly-job-log-2017-11-07-15.json.gz` | Every Philly job with an attempt between 7 and 16 Nov 2017 (16,062 jobs), as in `cluster_job_log` | [msr-fiddle/philly-traces](https://github.com/msr-fiddle/philly-traces) (Jeon et al., ATC '19) | CC BY 4.0 |
| `philly-machine-list.csv` | Philly `cluster_machine_list` (552 machines) | same | CC BY 4.0 |
| `sysfs-infiniband-counters.txt` | `/sys/class/infiniband/*/ports/*/{counters,hw_counters}/*` from hosts with mlx4, mlx5 and hfi1 adapters, as `grep -H .` prints them | [prometheus/procfs](https://github.com/prometheus/procfs) `testdata/fixtures.ttar` | Apache-2.0 |
| `nfs-mountstats.txt` | `/proc/<pid>/mountstats` with an NFSv4 mount (`statvers=1.1`, 8-field per-op lines, a wrapped 64-bit queue time on ACCESS) | same | Apache-2.0 |
| `lustre/lustrefs-OST0000/job_stats`, `lustre/lustrefs-MDT0000/job_stats` | `/proc/fs/lustre/{obdfilter,mdt}/*/job_stats` from a Lustre 2.10 server (bytes and counts, no latency) | [HewlettPackard/lustre_exporter](https://github.com/HewlettPackard/lustre_exporter) | Apache-2.0 |
| `mlx5-ethtool-counter-names.txt` | The counter names the mlx5 driver documents for `ethtool -S` | Linux `Documentation/networking/device_drivers/ethernet/mellanox/mlx5/counters.rst` | GPL-2.0 (names only) |
| `zeus/summary_power_{a40,v100,p100,rtx6000}.csv` | Epoch time and average power of 6 training workloads at every power limit, on 4 GPU types (1,609 runs) | [ml-energy/zeus](https://github.com/ml-energy/zeus) `examples/research_reproducibility/zeus_nsdi23/trace` (You et al., NSDI '23) | Apache-2.0 |

`tools/fetch-public-data.sh` downloads the full Philly traces for larger runs.
