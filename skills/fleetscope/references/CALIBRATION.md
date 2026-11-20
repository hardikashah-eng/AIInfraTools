# Calibration

FleetScope starts from spec-sheet performance with fixed efficiency factors. Calibration fits that model to measurements, so the numbers can be trusted for a given fleet.

## Serving pools

**Calibrate** in the fleet toolbar fits two multipliers for one pool:
- **prefill**: scales prefill throughput.
- **decode**: scales the decode step's fixed, per-sequence and per-context-token time.

It re-simulates the measured load and adjusts the multipliers until simulated TTFT and TPOT match the measured p50s. It then checks the spec's acceptance bar: within 10% at p50 and 20% at p99.

Measurements can come from:

| Source | How to get it | What is read |
| --- | --- | --- |
| Recorded trace | A trace on the Trace replay node with TTFT (and end-to-end latency for TPOT); see [TRACES.md](TRACES.md) | Per-request recorded latency on that pool, with the graph as drawn |
| vLLM `/metrics` | `curl http://server:8000/metrics > metrics.prom`, plus the minutes the counters cover (server uptime) | `vllm:time_to_first_token_seconds` and `vllm:time_per_output_token_seconds` histograms, prompt and generation token counters, request counts |
| benchmark_serving | `python benchmarks/benchmark_serving.py ... --save-result` | median and p99 TTFT and TPOT, request rate, and the prompt and output lengths it used |

For `/metrics` and benchmark results, the pool is simulated alone at the measured request rate. A recorded trace keeps the token sizes; otherwise sizes are log-normal around the measured means. Set **Instances that served it** to the number of vLLM servers measured.

**Apply** writes the multipliers onto the pool: it shows "✓ calibrated" and they can be edited in the pool's form.

### When the fit fails

The result names the reason rather than forcing a fit:
- **The measured window was overloaded** (TTFT p99 more than 8× p50). Deep queueing can't be fitted reliably; use a window where the fleet met its SLO.
- **The graph lacks capacity.** Simulated TTFT is mostly queueing, so speed can't close the gap. Match instances, max batch and KV cache to the measured fleet first.
- **A multiplier hit its limit.** The model, GPU type or precision probably differ from the measured fleet.
- **Only the tail differs.** Routing, batching or burstiness differ.

The tests check recovery against a hidden ground truth: the on-prem pool made 25% slower in prefill and 30% slower in decode. The fit recovers 0.78 and 1.34 from a `/metrics` snapshot, from a benchmark result and from a recorded trace.

## Training

In the Training tab:
- **Import step timings** reads a CSV with `step, step_time` and, when logged, `data_time, compute, comm` (seconds). It fits kernel efficiency from compute time, comm overlap from exposed all-reduce time, and the dataloader rate from exposed data time.
- **Import fault log** now also gives the log's fault rate per GPU-day (faults ÷ GPUs × days covered). **Use this rate** applies it to the job.
