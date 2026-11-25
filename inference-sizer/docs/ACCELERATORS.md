# Accelerator registry

`src/accelerators.js` is the one list of chips and vendors that every tool in the repo reads:

| Reader | What it takes |
| --- | --- |
| Inference Sizer catalog (`src/catalog.js`) | the spec-sheet figures, for sizing |
| FleetScope engine | the same figures plus board power and on-prem cost, for simulation |
| fleetops power model | board power by telemetry SKU name, when the exporter doesn't report the limit |
| fleetops serving manifests (vLLM, llm-d) | the vendor's Kubernetes resource, vLLM images and KV-cache buffer device |
| fleetops Kubernetes inventory | the vendor's resource and product labels |
| gpu-health | nothing directly; every `vendorKey` must have a gpu-health vendor profile (`gpu-health/src/vendors.mjs`), and a test checks that |

## Add a chip

Add an entry to `ACCELERATORS`. Use per-chip dense figures: halve "with sparsity" numbers, and divide rack or system
totals by the chip count. Set `source` to the vendor's spec page, and give board power (`tdpW`) and a `match` regex
for the names telemetry reports. Put more specific names first; for example, GB200 must come before B200. Prices are
placeholders, not quotes. Then run `npm test` at the repo root: `tests/accelerators.test.mjs` validates every entry.

A chip that only shows up in telemetry, with no full spec sheet, goes in `OTHER_SKUS` with `tdpW` and `match`.

## Add a vendor

Add an entry to `VENDORS` with:
- the Kubernetes resource and product labels;
- the telemetry tool and exporter;
- the collective library;
- the vLLM images;
- the KV-cache buffer device.

Then add a gpu-health vendor profile, which maps the exporter's metrics, fault codes and repair commands. Any tool
that meets a vendor without an adapter stops with an error that lists the vendors it knows. It never falls back to
NVIDIA.

## Cloud TPUs

TPU v6e (Trillium), v5p and TPU7x (Ironwood) are in the registry with `kind: 'tpu'`, from Google's TPU pages. Their
figures are adjusted to the sizer's model:
- ICI bandwidth is halved to per direction.
- `domain` is the chips on one TPU VM host: 8 on v6e, 4 on v5p and TPU7x. The sizer treats ICI between hosts in a
  slice as data-center network, so tensor parallelism beyond one host is costed pessimistically.
- TPUs publish no board power, so FleetScope's power model leaves them out.
- Prices are on-demand $ per chip-hour.

## Cloud instance types

`INSTANCES` maps machine types to a chip and a count, so bills and node labels name the GPU:
- AWS: P4, P5, P6, G4dn, G5, G6, G6e.
- GCP: A2, A3, A4, A4X, G2, and the TPU machine types (`ct6e-…`, `ct5p-…`, `tpu7x-…`, `ct5lp-…`).

`tpuTopology(chip, n)` gives GKE's slice topology for `n` chips (`2x4`, `2x2x1`, …).

## Sources for the newer chips

| Chip | Figures | Source |
| --- | --- | --- |
| MI355X | 288 GB HBM3E, 8 TB/s, 2516.6 / 5033.2 / 10066.3 dense BF16 / FP8 / FP4 TFLOPS, 7 × 144 GB/s Infinity Fabric (504 GB/s per direction), 1400 W | [AMD product page](https://www.amd.com/en/products/accelerators/instinct/mi350/mi355x.html), [brochure](https://www.amd.com/content/dam/amd/en/documents/instinct-tech-docs/product-briefs/amd-instinct-mi355x-gpu-brochure.pdf) |
| MI325X | 256 GB HBM3E, 6 TB/s, 1307.4 / 2614.9 dense BF16 / FP8 TFLOPS, 896 GB/s peer-to-peer (448 per direction), 1000 W | [AMD product page](https://www.amd.com/en/products/accelerators/instinct/mi300/mi325x.html), [datasheet](https://www.amd.com/content/dam/amd/en/documents/instinct-tech-docs/product-briefs/instinct-mi325x-datasheet.pdf) |
| TPU v6e | 32 GB HBM, 1.64 TB/s, 918 BF16 TFLOPS, ICI 800 GB/s bidirectional, 8 chips per host, 4 × 200 Gbps NICs per host | [Cloud TPU v6e](https://docs.cloud.google.com/tpu/docs/v6e) |
| TPU v5p, TPU7x | v5p: 95 GiB, 2765 GB/s, 459 TFLOPS. TPU7x: 192 GiB, 7.37 TB/s, 2307 BF16 / 4614 FP8 TFLOPS. ICI 1200 GB/s bidirectional for both | [TPU7x (Ironwood)](https://docs.cloud.google.com/tpu/docs/tpu7x) |
| GB300 NVL72 | rack: 20 TB HBM3e and 576 TB/s, 360 / 720 PFLOPS BF16 / FP8 (with sparsity), 1080 PFLOPS FP4 dense, 1.8 TB/s NVLink per GPU; ÷ 72 per GPU. Board power 1400 W from [InferenceX](https://inferencex.semianalysis.com/chips/gb300-nvl72) | [NVIDIA GB300 NVL72](https://www.nvidia.com/en-us/data-center/gb300-nvl72/) |
