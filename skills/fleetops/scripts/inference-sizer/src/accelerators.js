/* The accelerator registry: every chip the tools know, in one place, and what each vendor's stack needs.
   The Inference Sizer's catalog, FleetScope's GPU table, fleetops' power model and serving manifests all read it, so a
   new chip or vendor is one edit here (plus a gpu-health vendor profile if its exporter is new).

   ACCELERATORS  chips with full spec-sheet figures, usable for sizing and simulation
     id, label, vendor (display), vendorKey (key into VENDORS and gpu-health's vendor profiles), kind (gpu | tpu | …)
     hbmGB, hbmTBs, tfBf16, tfFp8, tfFp4   per chip, dense (sparsity figures halved; rack or system totals divided)
     scaleUpGBs   chip-to-chip link, per direction (NVLink, Infinity Fabric, ICI); domain: chips per scale-up domain
     nicGbps      scale-out network per chip; nodeKW: max power per domain where the vendor publishes it
     tdpW         board power on the spec sheet (TBP/TDP); match: regex for the SKU names telemetry reports
     price, onprem  placeholder $/chip-hour (rent, and amortized on-prem cost for FleetScope), not quotes
     short        FleetScope's key and short label, where it differs from id; source: spec sheet URL
   OTHER_SKUS    chips seen in telemetry but not sized (only power and vendor): id, vendorKey, kind, tdpW, match
   VENDORS       per vendor: Kubernetes resource and labels, telemetry tools, collective library, serving images

   Order matters for match: more specific names first (GB200 before B200, H100 PCIe before H100). */
(function (root) {
  'use strict';

  const VENDORS = {
    nvidia: {
      name: 'NVIDIA', kind: 'gpu', k8sResource: 'nvidia.com/gpu', productLabels: ['nvidia.com/gpu.product'],
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
    A({ id: 'MI300X', label: 'AMD Instinct MI300X (8-GPU)', vendor: 'AMD', vendorKey: 'amd', hbmGB: 192, hbmTBs: 5.3, tfBf16: 1307, tfFp8: 2615, scaleUpGBs: 448, domain: 8, nicGbps: 400, nodeKW: 10, tdpW: 750, price: 2.6, onprem: 1.5, match: 'MI300X',
      source: 'https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html' }),
  ];

  const OTHER_SKUS = [
    { id: 'H100-PCIe', vendorKey: 'nvidia', kind: 'gpu', tdpW: 350, match: 'H100.*PCIe' },
    { id: 'H20', vendorKey: 'nvidia', kind: 'gpu', tdpW: 400, match: 'H20\\b' },
    { id: 'A100-PCIe', vendorKey: 'nvidia', kind: 'gpu', tdpW: 300, match: 'A100.*PCIe' },
    { id: 'L4', vendorKey: 'nvidia', kind: 'gpu', tdpW: 72, match: 'L4\\b' },
    { id: 'A10', vendorKey: 'nvidia', kind: 'gpu', tdpW: 150, match: 'A10\\b' },
    { id: 'T4', vendorKey: 'nvidia', kind: 'gpu', tdpW: 70, match: 'T4\\b' },
    { id: 'V100', vendorKey: 'nvidia', kind: 'gpu', tdpW: 300, match: 'V100' },
    { id: 'MI350X', vendorKey: 'amd', kind: 'gpu', tdpW: 1000, match: 'MI350' },
    { id: 'MI250', vendorKey: 'amd', kind: 'gpu', tdpW: 560, match: 'MI250' },
  ];

  // telemetry SKU string ("NVIDIA H100 80GB HBM3", "AMD Instinct MI300X", …) → registry entry, most specific first
  const ORDER = (() => {
    const all = ACCELERATORS.concat(OTHER_SKUS).map(x => ({ x, re: new RegExp(x.match, 'i') }));
    // a PCIe variant before its SXM sibling; otherwise registry order (which lists GB* before B*)
    return all.filter(a => /PCIe/.test(a.x.id)).concat(all.filter(a => !/PCIe/.test(a.x.id)));
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

  const api = { VENDORS, ACCELERATORS, OTHER_SKUS, match, byId, tdpOf, vendorKeyOf, vendor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AIInfraAccelerators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
