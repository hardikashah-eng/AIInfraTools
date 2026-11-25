# AMD fixtures

amd-smi output for an 8-GPU MI300X node and an RCCL job log. They are **not captured from hardware**:

- The amd-smi files follow the field names in `amdsmi_cli/amdsmi_commands.py` and the examples in amd-smi's
  CHANGELOG and CLI docs ([ROCm/amdsmi](https://github.com/ROCm/amdsmi), MIT license). They are widened to 8 GPUs,
  with one GPU on older IFWI firmware and one PCIe link trained at x8.
- `amd-smi-topology-old.json` is the older topology layout, verbatim from amd-smi's CHANGELOG.
- `rccl.log` uses RCCL's line formats: the version banner from `src/init.cc` and the `host:pid:tid [dev] … NCCL WARN`
  prefix from `src/debug.cc` in [ROCm/rccl](https://github.com/ROCm/rccl). The messages are NCCL's IB and socket
  errors, and PyTorch's HIP out-of-memory error.

Replace them with captures from your own nodes when you have them. The parsers read both the list layout and the
`{"gpu_data": [...]}` layout, and values written either as plain numbers or as `{value, unit}`.
