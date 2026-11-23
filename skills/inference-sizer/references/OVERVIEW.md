# Inference Sizer

How many GPUs do you need to serve a model at your latency targets, and how should you lay them out? Pick a model and a GPU, then enter your traffic (concurrent sessions, DAU, tokens per request), context window and TTFT/TPOT targets. Inference Sizer recommends:
- the number of GPUs, nodes or racks,
- tensor/expert/pipeline parallelism per instance,
- whether to split prefill and decode onto separate pools,
- estimated latency, memory use and cost per output token.

It answers in milliseconds for one peak-load snapshot. To see how that answer holds up over time (bursts, cold starts, cross-site links, failures), use **Export to FleetScope** and replay it in [FleetScope](../fleetscope/).

> **Uncalibrated.** Performance comes from spec-sheet figures and editable efficiency factors (a first-order roofline), and GPU prices are placeholders. Treat results as directional until you calibrate the engine assumptions against a benchmark of your own stack. See [docs/METHOD.md](METHOD.md).

## Run it

Open `dist/index.html` in a browser. It is a single self-contained file with no server and no install. Inputs and any GPUs or models you add are kept in the browser.

From the command line:

```bash
node tools/size.mjs --model llama33-70b --gpu B200 --set conc=800 --set tpot=25
node tools/size.mjs --list                                     # GPU and model ids
node tools/size.mjs --catalog specs/example.json --model qwen3-30b-a3b --gpu H200 --json
node tools/size.mjs --model deepseek-v3 --gpu B200 --fleetscope ../fleetscope/scenarios/deepseek/graph.json
node tools/size.mjs --model llama33-70b --compare B200,H200,MI300X --set tpot=25   # same targets on several GPUs, cheapest first
echo '{"model":"llama33-70b","gpu":"H200","conc":400}' | node tools/size.mjs --input - --json
node tools/size.mjs --list --json                              # full GPU and model specs, and every input name
node tools/size.mjs --model llama33-70b --gpu H200 --set conc=800 --calibration profile.json   # measured efficiencies
```

**Calibration.** The engine efficiencies (`effPrefill`, `effDecodeBW`, `effDecodeComp`) default to conservative spec-sheet values. `--calibration FILE` replaces them with values fitted to measurements for the same GPU and model. Make the file with `fleetops calibrate benchmarks` from MLPerf or `benchmark_serving` results. `--input` and `--set` still win, and the output says which profile was used. On MLPerf Inference v5.0 Llama 2 70B server runs, the defaults asked for twice the GPUs the measured 8-GPU systems used; see [fleetops/docs/CALIBRATION.md](../fleetops/docs/CALIBRATION.md).

Develop: `npm test`, then `npm run build` to rebuild `dist/index.html` from `src/`.

## What it covers

- **GPUs:** B200, B300, GB200 NVL72, H200, H100, A100, L40S and MI300X built in. The model reads everything from a spec sheet: HBM size and bandwidth; BF16, FP8 and FP4 dense TFLOPS; link speeds; GPUs per scale-up domain (8 for HGX, 72 for NVL72); power; price.
- **Models:** 12 built in, dense and MoE, including GQA, MLA (DeepSeek, Kimi) and sliding-window attention (gpt-oss, Llama 4). From 8B to the 1T-parameter Kimi K2.
- **Precision:** BF16, FP8 or FP4 weights; BF16 or FP8 KV cache. A GPU without FP4 or FP8 tensor cores keeps the memory saving but computes at the next precision up.
- **Context window:** it caps the longest request, and one full-length request must fit an instance. With *reserve the full context per session*, the window sets KV memory for every session.
- **Layouts:** 1 to 64 GPUs per instance:
  - TP, TP + EP, data-parallel attention + EP (for MLA),
  - pipeline parallel across nodes for dense models,
  - context-parallel prefill for long prompts.
- **Serving architectures:** aggregated (chunked prefill) or disaggregated prefill/decode with KV transfer; auto picks the cheaper.
- **Fleet:** instances packed into nodes or racks, with room for one spare instance (N+1).

## Screenshots

### Recommendation

Llama 3.3 70B in FP8 on B200 for 500 concurrent sessions and 50K DAU, with a 1 s TTFT and a 30 ms TPOT: four 4-GPU instances serving prefill and decode together, in three 8-GPU nodes.


### Topology, latency and memory

Instances on nodes, the latency check against your targets, and the decode step-time curve that sets streams per instance.


### Racks with a 72-GPU NVLink domain

DeepSeek-V3 on GB200 NVL72: one 16-GPU wide-EP instance, with the spare instance in the same rack.


### Adding hardware: edit a spec sheet and save it

Change any figure (here, measured HBM bandwidth), name it and save it as a new GPU. To share entries, export them as a spec sheet. See [docs/SPEC-SHEETS.md](SPEC-SHEETS.md).


### Adding a model from its Hugging Face config.json

Paste or upload `config.json`. The architecture is read and the parameter counts are estimated from the layer shapes; here Qwen3-235B-A22B comes out at 235B total and 22B active.


### Export to FleetScope

The export holds the model, your targets, a chat source arriving at the sized peak rate, and the recommended pools with GPUs per instance set.


In FleetScope, **Load graph JSON** runs it. The same recommendation replays at 99.8% SLO attainment.


## Files

| Path | What it is |
| --- | --- |
| `src/catalog.js` | Built-in GPUs and models, field schemas, spec-sheet and `config.json` import |
| `src/model.js` | The sizing model (`plan(s)`) |
| `src/fleetscope.js` | Export to a FleetScope graph |
| `src/ui.js`, `src/index.src.html` | The page |
| `specs/example.json` | Example spec sheet (one GPU, one model) |
| `tools/size.mjs` | CLI |
| `tests/` | Catalog, model and cross-tool FleetScope tests |
