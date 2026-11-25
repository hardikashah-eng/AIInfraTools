/* The accelerator registry: every chip the tools know, in one place, and what each vendor's stack needs.
   The Inference Sizer's catalog, FleetScope's GPU table, fleetops' power model and serving manifests all read it, so a
   new chip or vendor is one edit here (plus a gpu-health vendor profile if its exporter is new).

   ACCELERATORS  chips with full spec-sheet figures, usable for sizing and simulation
     id, label, vendor (display), vendorKey (key into VENDORS and gpu-health's vendor profiles), kind (gpu | tpu | …)
     hbmGB, hbmTBs, tfBf16, tfFp8, tfFp4   per chip, dense (sparsity figures halved; rack or system totals divided)
     scaleUpGBs   chip-to-chip link, per direction (NVLink, Infinity Fabric, ICI); domain: chips per scale-up domain
     nicGbps      scale-out network per chip; nodeKW: max power per domain where the vendor publishes it
     tdpW         board power on the spec sheet (TBP/TDP; none for cloud-only chips that don't publish it); match: regex
                  for the SKU names telemetry, Kubernetes labels and bills report
     gkeAccelerator  GKE's cloud.google.com/gke-tpu-accelerator value, for TPU node selectors
     price, onprem  placeholder $/chip-hour (rent, and amortized on-prem cost for FleetScope), not quotes
     short        FleetScope's key and short label, where it differs from id; source: spec sheet URL
   OTHER_SKUS    chips seen in telemetry but not sized (only power and vendor): id, vendorKey, kind, tdpW, match
   VENDORS       per vendor: Kubernetes resource and labels, telemetry tools, collective library, serving images
   INSTANCES     cloud instance types → { cloud, chip (registry id or SKU), gpus }, for bills and node labels

   Order matters for match: more specific names first (GB200 before B200, H100 PCIe before H100). */
(function (root) {
  'use strict';

  const VENDORS = {
    nvidia: {
      name: 'NVIDIA', kind: 'gpu', k8sResource: 'nvidia.com/gpu', productLabels: ['nvidia.com/gpu.product', 'cloud.google.com/gke-accelerator'],
      smi: 'nvidia-smi', exporter: 'dcgm-exporter', collectives: 'NCCL', kvBufferDevice: 'cuda',
      images: { vllm: 'vllm/vllm-openai', llmdVllm: 'docker.io/vllm/vllm-openai:v0.31.0' },
    },
    amd: {
      name: 'AMD', kind: 'gpu', k8sResource: 'amd.com/gpu', productLabels: ['amd.com/gpu.product-name'],
      smi: 'amd-smi', exporter: 'device-metrics-exporter', collectives: 'RCCL',
      // NIXL's UCX path on ROCm stages the KV cache through host memory in llm-d's P/D guide
      kvBufferDevice: 'cpu',
      images: { vllm: 'rocm/vllm', llmdVllm: 'docker.io/vllm/vllm-openai-rocm:v0.31.0' },
    },
    // Cloud TPU on GKE: chips requested as google.com/tpu, the slice chosen by accelerator and topology node labels.
    // vLLM on TPU: the vllm/vllm-tpu image (GKE's Trillium tutorial). No llm-d P/D image validated for TPU here.
    tpu: {
      name: 'Google Cloud TPU', kind: 'tpu', k8sResource: 'google.com/tpu', productLabels: ['cloud.google.com/gke-tpu-accelerator'],
      topologyLabel: 'cloud.google.com/gke-tpu-topology', smi: 'tpu-info', exporter: 'Cloud Monitoring (accelerator metrics) or libtpu', collectives: 'XLA collectives over ICI',
      images: { vllm: 'vllm/vllm-tpu' },
    },
  };

  const A = (o) => Object.assign({ kind: 'gpu', tfFp4: 0 }, o);
  const ACCELERATORS = [
    A({ id: 'GB300-NVL72', short: 'GB300', label: 'NVIDIA GB300 NVL72 (72-GPU rack)', vendor: 'NVIDIA', vendorKey: 'nvidia', hbmGB: 278, hbmTBs: 8, tfBf16: 2500, tfFp8: 5000, tfFp4: 15000, scaleUpGBs: 900, domain: 72, nicGbps: 800, tdpW: 1400, price: 7.5, onprem: 4.4, match: 'GB300',
      // rack figures ÷ 72: 20 TB HBM, 576 TB/s, 360/720/1080 PFLOPS BF16 (sparse)/FP8 (sparse)/FP4 (dense); board power from InferenceX's chip page
      source: 'https://www.nvidia.com/en-us/data-center/gb300-nvl72/' }),
    A({ id: 'GB200-NVL72', short: 'GB200', label: 'NVIDIA GB200 NVL72 (72-GPU rack)', vendor: 'NVIDIA', vendorKey: 'nvidia', hbmGB: 186, hbmTBs: 8, tfBf16: 2500, tfFp8: 5000, tfFp4: 10000, scaleUpGBs: 900, domain: 72, nicGbps: 400, nodeKW: 120, tdpW: 1200, price: 6.0, onprem: 3.6, match: 'GB200',
      source: 'https://www.nvidia.com/en-us/data-center/gb200-nvl72/' }),
    A({ id: 'B300', label: 'NVIDIA B300 (HGX, 8-GPU)', vendor: 'NVIDIA', vendorKey: 'nvidia', hbmGB: 262, hbmTBs: 8, tfBf16: 2250, tfFp8: 4500, tfFp4: 13500, scaleUpGBs: 900, domain: 8, nicGbps: 800, nodeKW: 14.5, tdpW: 1100, price: 7.0, onprem: 4.0, match: 'B300',
      source: 'https://www.nvidia.com/en-us/data-center/hgx/' }),
    A({ id: 'B200', label: 'NVIDIA B200 (HGX, 8-GPU)', vendor: 'NVIDIA', vendorKey: 'nvidia', hbmGB: 180, hbmTBs: 8, tfBf16: 2250, tfFp8: 4500, tfFp4: 9000, scaleUpGBs: 900, domain: 8, nicGbps: 400, nodeKW: 14.3, tdpW: 1000, price: 5.5, onprem: 3.2, match: 'B200',
      source: 'https://www.nvidia.com/en-us/data-center/dgx-b200/' }),
    A({ id: 'H200', label: 'NVIDIA H200 SXM (8-GPU)', vendor: 'NVIDIA', vendorKey: 'nvidia', hbmGB: 141, hbmTBs: 4.8, tfBf16: 989, tfFp8: 1979, scaleUpGBs: 450, domain: 8, nicGbps: 400, nodeKW: 10.2, tdpW: 700, price: 3.5, onprem: 2.0, match: 'H200',
      source: 'https://www.nvidia.com/en-us/data-center/h200/' }),
    A({ id: 'H100', label: 'NVIDIA H100 SXM (8-GPU)', vendor: 'NVIDIA', vendorKey: 'nvidia', hbmGB: 80, hbmTBs: 3.35, tfBf16: 989, tfFp8: 1979, scaleUpGBs: 450, domain: 8, nicGbps: 400, nodeKW: 10.2, tdpW: 700, price: 2.4, onprem: 1.4, match: 'H100(?!.*PCIe)|H800',
      source: 'https://www.nvidia.com/en-us/data-center/h100/' }),
    A({ id: 'A100', label: 'NVIDIA A100 80GB SXM (8-GPU)', vendor: 'NVIDIA', vendorKey: 'nvidia', hbmGB: 80, hbmTBs: 2.0, tfBf16: 312, tfFp8: 0, scaleUpGBs: 300, domain: 8, nicGbps: 200, nodeKW: 6.5, tdpW: 400, price: 1.6, onprem: 0.9, match: 'A100(?!.*PCIe)|A800',
      source: 'https://www.nvidia.com/en-us/data-center/a100/' }),
    A({ id: 'L40S', label: 'NVIDIA L40S (PCIe, 8 per server)', vendor: 'NVIDIA', vendorKey: 'nvidia', hbmGB: 48, hbmTBs: 0.864, tfBf16: 362, tfFp8: 733, scaleUpGBs: 32, domain: 8, nicGbps: 200, nodeKW: 5, tdpW: 350, price: 1.1, onprem: 0.7, match: 'L40S',
      source: 'https://www.nvidia.com/en-us/data-center/l40s/' }),
    A({ id: 'MI355X', label: 'AMD Instinct MI355X (8-GPU)', vendor: 'AMD', vendorKey: 'amd', hbmGB: 288, hbmTBs: 8, tfBf16: 2516.6, tfFp8: 5033.2, tfFp4: 10066.3, scaleUpGBs: 504, domain: 8, nicGbps: 400, tdpW: 1400, price: 4.5, onprem: 2.6, match: 'MI355',
      // Infinity Fabric: 7 links × 144 GB/s (bidirectional) = 504 GB/s per direction
      source: 'https://www.amd.com/en/products/accelerators/instinct/mi350/mi355x.html' }),
    A({ id: 'MI325X', label: 'AMD Instinct MI325X (8-GPU)', vendor: 'AMD', vendorKey: 'amd', hbmGB: 256, hbmTBs: 6, tfBf16: 1307.4, tfFp8: 2614.9, scaleUpGBs: 448, domain: 8, nicGbps: 400, tdpW: 1000, price: 2.9, onprem: 1.7, match: 'MI325',
      // platform peer-to-peer I/O 896 GB/s bidirectional = 448 GB/s per direction
      source: 'https://www.amd.com/en/products/accelerators/instinct/mi300/mi325x.html' }),
    // Cloud TPU: per chip, from cloud.google.com/tpu/docs (v6e, tpu7x pages). ICI figures are bidirectional there, halved
    // here. domain = chips per TPU VM host; ICI across hosts in a slice is modelled as the data-center network, so
    // tensor parallelism beyond one host is costed pessimistically. Prices: on-demand $/chip-hour, us-east1/us-central1.
    A({ id: 'TPU7x', label: 'Google TPU7x (Ironwood), 4 per host', vendor: 'Google', vendorKey: 'tpu', kind: 'tpu', hbmGB: 192, hbmTBs: 7.37, tfBf16: 2307, tfFp8: 4614, scaleUpGBs: 600, domain: 4, nicGbps: 100, price: 12.0, gkeAccelerator: 'tpu7x', match: 'tpu7x|ironwood|TpuV7',
      source: 'https://docs.cloud.google.com/tpu/docs/tpu7x' }),
    A({ id: 'TPU-v6e', short: 'v6e', label: 'Google TPU v6e (Trillium), 8 per host', vendor: 'Google', vendorKey: 'tpu', kind: 'tpu', hbmGB: 32, hbmTBs: 1.64, tfBf16: 918, tfFp8: 918, scaleUpGBs: 400, domain: 8, nicGbps: 100, price: 2.7, gkeAccelerator: 'tpu-v6e-slice', match: 'v6e|trillium',
      source: 'https://docs.cloud.google.com/tpu/docs/v6e' }),
    A({ id: 'TPU-v5p', short: 'v5p', label: 'Google TPU v5p, 4 per host', vendor: 'Google', vendorKey: 'tpu', kind: 'tpu', hbmGB: 102, hbmTBs: 2.765, tfBf16: 459, tfFp8: 459, scaleUpGBs: 600, domain: 4, nicGbps: 50, price: 4.2, gkeAccelerator: 'tpu-v5p-slice', match: 'v5p',
      // 95 GiB HBM per chip
      source: 'https://docs.cloud.google.com/tpu/docs/tpu7x' }),
    A({ id: 'MI300X', label: 'AMD Instinct MI300X (8-GPU)', vendor: 'AMD', vendorKey: 'amd', hbmGB: 192, hbmTBs: 5.3, tfBf16: 1307, tfFp8: 2615, scaleUpGBs: 448, domain: 8, nicGbps: 400, nodeKW: 10, tdpW: 750, price: 2.6, onprem: 1.5, match: 'MI300X',
      source: 'https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html' }),
  ];

  const OTHER_SKUS = [
    { id: 'H100-PCIe', vendorKey: 'nvidia', kind: 'gpu', tdpW: 350, match: 'H100.*PCIe' },
    { id: 'H20', vendorKey: 'nvidia', kind: 'gpu', tdpW: 400, match: 'H20\\b' },
    { id: 'A100-PCIe', vendorKey: 'nvidia', kind: 'gpu', tdpW: 300, match: 'A100.*PCIe' },
    { id: 'A100-40GB', vendorKey: 'nvidia', kind: 'gpu', tdpW: 400, match: 'A100.*40\\s?GB' },
    { id: 'A10G', vendorKey: 'nvidia', kind: 'gpu', tdpW: 300, match: 'A10G' },
    { id: 'L4', vendorKey: 'nvidia', kind: 'gpu', tdpW: 72, match: 'L4\\b' },
    { id: 'A10', vendorKey: 'nvidia', kind: 'gpu', tdpW: 150, match: 'A10\\b' },
    { id: 'T4', vendorKey: 'nvidia', kind: 'gpu', tdpW: 70, match: 'T4\\b' },
    { id: 'V100', vendorKey: 'nvidia', kind: 'gpu', tdpW: 300, match: 'V100' },
    { id: 'MI350X', vendorKey: 'amd', kind: 'gpu', tdpW: 1000, match: 'MI350' },
    { id: 'MI250', vendorKey: 'amd', kind: 'gpu', tdpW: 560, match: 'MI250' },
    { id: 'TPU-v5e', vendorKey: 'tpu', kind: 'tpu', match: 'v5e|v5-?lite' },
  ];

  // ---------- cloud instance types ----------
  // AWS: docs.aws.amazon.com/AWSEC2/latest/UserGuide/accelerated-computing-instances.html and aws.amazon.com/ec2/instance-types/p6/
  const INSTANCES = {};
  const add = (cloud, chip, list) => { for (const [type, gpus] of list) INSTANCES[type] = { cloud, chip, gpus }; };
  const sizes = (fam, one, more) => one.map(s => [`${fam}.${s}`, 1]).concat(more.map(([s, n]) => [`${fam}.${s}`, n]));
  add('aws', 'A100-40GB', [['p4d.24xlarge', 8]]);
  add('aws', 'A100', [['p4de.24xlarge', 8]]);
  add('aws', 'H100', [['p5.4xlarge', 1], ['p5.48xlarge', 8]]);
  add('aws', 'H200', [['p5e.48xlarge', 8], ['p5en.48xlarge', 8]]);
  add('aws', 'B200', [['p6-b200.48xlarge', 8]]);
  add('aws', 'B300', [['p6-b300.48xlarge', 8]]);
  add('aws', 'GB200-NVL72', [['p6e-gb200.36xlarge', 4]]); // sold as UltraServers of 36 or 72 GPUs (u-p6e-gb200x36, x72)
  add('aws', 'L40S', sizes('g6e', ['xlarge', '2xlarge', '4xlarge', '8xlarge', '16xlarge'], [['12xlarge', 4], ['24xlarge', 4], ['48xlarge', 8]]));
  add('aws', 'L4', sizes('g6', ['xlarge', '2xlarge', '4xlarge', '8xlarge', '16xlarge'], [['12xlarge', 4], ['24xlarge', 4], ['48xlarge', 8]]));
  add('aws', 'A10G', sizes('g5', ['xlarge', '2xlarge', '4xlarge', '8xlarge', '16xlarge'], [['12xlarge', 4], ['24xlarge', 4], ['48xlarge', 8]]));
  add('aws', 'T4', sizes('g4dn', ['xlarge', '2xlarge', '4xlarge', '8xlarge', '16xlarge'], [['12xlarge', 4], ['metal', 8]]));
  // GCP: docs.cloud.google.com/compute/docs/gpus and /compute/docs/tpus/tpu-machines; GKE TPU machine types
  const gpuN = (fam, chip, ns) => add('gcp', chip, ns.map(n => [`${fam}-${n}g`, n]));
  gpuN('a2-highgpu', 'A100-40GB', [1, 2, 4, 8]); add('gcp', 'A100-40GB', [['a2-megagpu-16g', 16]]);
  gpuN('a2-ultragpu', 'A100', [1, 2, 4, 8]);
  gpuN('a3-highgpu', 'H100', [1, 2, 4, 8]); add('gcp', 'H100', [['a3-megagpu-8g', 8], ['a3-edgegpu-8g', 8]]);
  add('gcp', 'H200', [['a3-ultragpu-8g', 8]]);
  add('gcp', 'B200', [['a4-highgpu-8g', 8]]);
  add('gcp', 'GB200-NVL72', [['a4x-highgpu-4g', 4]]);
  add('gcp', 'L4', [4, 8, 12, 16, 32].map(n => [`g2-standard-${n}`, 1]).concat([['g2-standard-24', 2], ['g2-standard-48', 4], ['g2-standard-96', 8]]));
  add('gcp', 'TPU-v6e', [['ct6e-standard-1t', 1], ['ct6e-standard-4t', 4], ['ct6e-standard-8t', 8]]);
  add('gcp', 'TPU-v5p', [['ct5p-hightpu-4t', 4]]);
  add('gcp', 'TPU7x', [['tpu7x-standard-4t', 4]]);
  add('gcp', 'TPU-v5e', [['ct5lp-hightpu-1t', 1], ['ct5lp-hightpu-4t', 4], ['ct5lp-hightpu-8t', 8]]);
  const instanceOf = type => INSTANCES[String(type || '').toLowerCase()] || null;
  // TPU slice topology for a chip count: 2D (v5e, v6e) or 3D torus (v4, v5p, 7x), as GKE's node selector wants it
  const TOPO2 = { 1: '1x1', 4: '2x2', 8: '2x4', 16: '4x4', 32: '4x8', 64: '8x8', 128: '8x16', 256: '16x16' };
  const TOPO3 = { 4: '2x2x1', 8: '2x2x2', 16: '2x2x4', 32: '2x4x4', 64: '4x4x4' };
  function tpuTopology(chip, chips) { const a = byId(chip) || match(chip); if (!a) return null; return (/v6e|v5e/i.test(a.id) ? TOPO2 : TOPO3)[chips] || null; }

  // telemetry SKU string ("NVIDIA H100 80GB HBM3", "AMD Instinct MI300X", …) → registry entry, most specific first
  const ORDER = (() => {
    const all = ACCELERATORS.concat(OTHER_SKUS).map(x => ({ x, re: new RegExp(x.match, 'i') }));
    // a PCIe or 40 GB variant before its sibling; otherwise registry order (which lists GB* before B*)
    const first = a => /PCIe|40GB/.test(a.x.id);
    return all.filter(first).concat(all.filter(a => !first(a)));
  })();
  function match(sku) {
    const s = String(sku || '');
    if (!s) return null;
    const exact = ACCELERATORS.concat(OTHER_SKUS).find(x => x.id.toLowerCase() === s.toLowerCase() || (x.short && x.short.toLowerCase() === s.toLowerCase()));
    if (exact) return exact;
    const hit = ORDER.find(a => a.re.test(s));
    return hit ? hit.x : null;
  }
  const byId = id => ACCELERATORS.find(x => x.id === id || x.short === id) || null;
  const tdpOf = sku => { const m = match(sku); return m ? m.tdpW : null; };
  // vendor key for an entry, a SKU string or a display vendor ("AMD"); null when unknown
  function vendorKeyOf(x) {
    if (!x) return null;
    if (typeof x === 'object') return x.vendorKey || vendorKeyOf(x.vendor) || vendorKeyOf(x.id);
    const s = String(x).toLowerCase();
    if (VENDORS[s]) return s;
    const v = Object.keys(VENDORS).find(k => VENDORS[k].name.toLowerCase() === s);
    if (v) return v;
    const m = match(x);
    return m ? m.vendorKey : null;
  }
  // the vendor's deployment adapter; throws with the known vendors when there is none
  function vendor(x) {
    const k = vendorKeyOf(x);
    if (!k || !VENDORS[k]) throw new Error(`no vendor adapter for ${typeof x === 'object' ? (x.id || x.vendor) : x}; known: ${Object.keys(VENDORS).join(', ')}`);
    return Object.assign({ key: k }, VENDORS[k]);
  }

  const api = { VENDORS, ACCELERATORS, OTHER_SKUS, INSTANCES, instanceOf, tpuTopology, match, byId, tdpOf, vendorKeyOf, vendor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AIInfraAccelerators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
