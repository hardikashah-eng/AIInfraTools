# Real data used by the tests

These files are real measurements or real tool output, kept small so the tests run in CI without downloads. Each test
that uses them says what it checks.

| File | What it is | Source | License |
| --- | --- | --- | --- |
| `philly-job-log-2017-11-07-15.json.gz` | Every Philly job with an attempt between 7 and 16 Nov 2017 (16,062 jobs), as in `cluster_job_log` | [msr-fiddle/philly-traces](https://github.com/msr-fiddle/philly-traces) (Jeon et al., ATC '19) | CC BY 4.0 |
| `philly-machine-list.csv` | Philly `cluster_machine_list` (552 machines) | same | CC BY 4.0 |

`tools/fetch-public-data.sh` downloads the full traces for larger runs.
| `zeus/summary_power_{a40,v100,p100,rtx6000}.csv` | Epoch time and average power of 6 training workloads at every power limit, on 4 GPU types (1,609 runs) | [ml-energy/zeus](https://github.com/ml-energy/zeus) `examples/research_reproducibility/zeus_nsdi23/trace` (You et al., NSDI '23) | Apache-2.0 |
