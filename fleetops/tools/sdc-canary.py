#!/usr/bin/env python3
"""Silent-data-corruption canary: the same deterministic work on every GPU of this node, compared.

Each GPU runs a fixed chain of matrix multiplies and reductions from a fixed seed, with deterministic algorithms,
in FP32 and BF16. GPUs of the same model must produce bit-identical results, so a GPU whose checksum differs from the
majority of its peers (or from --golden, a file of known-good checksums per GPU model) is computing wrong answers.
Writes one JSON line per GPU and test, for `fleetops data import sdc-checks`:

  {"t": 1763550000, "check": "canary", "node": "gpu-a17", "gpu": "3", "test": "matmul-fp32", "value": "9f2c…",
   "expected": "41aa…", "ok": false, "model": "NVIDIA H100 80GB HBM3"}

Usage: sdc-canary.py [--iters 20] [--size 4096] [--golden golden.json] [--write-golden golden.json] > canary.jsonl
Run it on idle GPUs (a diag job, burn-in, or before a node joins the training pool): it keeps every GPU busy for a
minute or two. Needs PyTorch with CUDA or ROCm.
"""
import argparse, hashlib, json, socket, sys, time
from collections import Counter


def checksum(t):
    return hashlib.sha256(t.detach().contiguous().view(-1).cpu().numpy().tobytes()).hexdigest()[:32]


def run(torch, device, dtype, size, iters, seed=1234):
    g = torch.Generator(device="cpu").manual_seed(seed)
    a = torch.randn(size, size, generator=g, dtype=torch.float32).to(device=device, dtype=dtype)
    b = torch.randn(size, size, generator=g, dtype=torch.float32).to(device=device, dtype=dtype)
    x = a
    for _ in range(iters):
        x = torch.tanh(x @ b) * 0.5 + a * 0.5  # bounded, so values stay finite and every element keeps changing
    s = torch.stack([x.float().sum(), (x.float() ** 2).sum(), x.float().abs().max()])
    return checksum(x.float()) + ":" + checksum(s)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--iters", type=int, default=20)
    p.add_argument("--size", type=int, default=4096)
    p.add_argument("--node", default=socket.gethostname())
    p.add_argument("--golden", help="JSON {model: {test: checksum}} of known-good results")
    p.add_argument("--write-golden", help="write this run's majority results as golden values")
    args = p.parse_args()
    try:
        import torch
    except ImportError:
        sys.exit("sdc-canary needs PyTorch (pip install torch)")
    if not torch.cuda.is_available():
        sys.exit("no GPU visible to PyTorch")
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    golden = json.load(open(args.golden)) if args.golden else {}
    tests = {"matmul-fp32": torch.float32, "matmul-bf16": torch.bfloat16}
    results = []  # (gpu, model, test, value)
    for i in range(torch.cuda.device_count()):
        model = torch.cuda.get_device_name(i)
        for name, dtype in tests.items():
            results.append((str(i), model, name, run(torch, f"cuda:{i}", dtype, args.size, args.iters)))
        torch.cuda.synchronize(i)
    now = int(time.time())
    majority = {}
    for model in {r[1] for r in results}:
        for name in tests:
            vals = Counter(r[3] for r in results if r[1] == model and r[2] == name)
            top, n = vals.most_common(1)[0]
            peers = sum(vals.values())
            # a majority among peers, else the golden value; with one GPU of a model only --golden can judge
            majority[(model, name)] = golden.get(model, {}).get(name) or (top if peers >= 3 and n > peers / 2 else None)
    for gpu, model, name, value in results:
        expected = majority[(model, name)]
        print(json.dumps({"t": now, "check": "canary", "node": args.node, "gpu": gpu, "test": name, "value": value,
                          "expected": expected, "ok": None if expected is None else value == expected, "model": model}))
    if args.write_golden:
        out = {}
        for (model, name), v in majority.items():
            if v:
                out.setdefault(model, {})[name] = v
        json.dump(out, open(args.write_golden, "w"), indent=1)


if __name__ == "__main__":
    main()
