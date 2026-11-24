# Real data used by the tests

These files are real measurements or real tool output, kept small so the tests run in CI without downloads. Each test
that uses them says what it checks.

| File | What it is | Source | License |
| --- | --- | --- | --- |
| `philly-job-log-2017-11-07-15.json.gz` | Every Philly job with an attempt between 7 and 16 Nov 2017 (16,062 jobs), as in `cluster_job_log` | [msr-fiddle/philly-traces](https://github.com/msr-fiddle/philly-traces) (Jeon et al., ATC '19) | CC BY 4.0 |
| `philly-machine-list.csv` | Philly `cluster_machine_list` (552 machines) | same | CC BY 4.0 |

`tools/fetch-public-data.sh` downloads the full Philly traces for larger runs.
