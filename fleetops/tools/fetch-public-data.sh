#!/usr/bin/env bash
# Download the public traces used to validate fleetops, and load them into a store.
#   tools/fetch-public-data.sh [DATA_DIR] [STORE_DIR]
# Philly is ~1 GB compressed; only the job log, machine list and one week of GPU utilization are extracted.
# Licenses: Philly, Azure LLM traces and AcmeTrace are CC BY 4.0 (cite their papers if you publish results);
# MLPerf results are MLCommons publications (unverified derived numbers must say so); they are stamped with the v5.0
# publication date, 2025-04-02.
set -euo pipefail
DATA=${1:-public-data}; STORE=${2:-fleet-data}
HERE=$(cd "$(dirname "$0")" && pwd); CLI="node $HERE/fleetops.mjs"
mkdir -p "$DATA"; cd "$DATA"

if [ ! -f philly-trace.tar.gz ]; then
  curl -fsSL -o philly-trace.tar.gz https://media.githubusercontent.com/media/msr-fiddle/philly-traces/master/trace-data.tar.gz
fi
echo "2037ccf63a725a02be718b0e1aeee6142c90b7f62d0d849295120e9f6ba13d2c  philly-trace.tar.gz" | sha256sum -c -
tar xzf philly-trace.tar.gz trace-data/cluster_job_log trace-data/cluster_machine_list
[ -f philly-gpu-util-nov8-14.csv ] || tar xzOf philly-trace.tar.gz trace-data/cluster_gpu_util | grep -E '^2017-11-(0[89]|1[0-4]) ' > philly-gpu-util-nov8-14.csv

for f in AzureLLMInferenceTrace_code.csv AzureLLMInferenceTrace_conv.csv; do
  [ -f "$f" ] || curl -fsSL -o "$f" "https://raw.githubusercontent.com/Azure/AzurePublicDataset/master/data/$f"
done

MLP=https://raw.githubusercontent.com/mlcommons/inference_results_v5.0/main
mkdir -p mlperf
for sys in closed/NVIDIA/results/DGX-H100_H100-SXM-80GBx8_TRT closed/NVIDIA/results/H200-SXM-141GBx8_TRT closed/NVIDIA/results/B200-SXM-180GBx8_TRT closed/AMD/results/8xMI325X_2xEPYC_9575F; do
  p="$sys/llama2-70b-99/Server/performance/run_1/mlperf_log_summary.txt"
  mkdir -p "mlperf/$(dirname "$p")"; [ -f "mlperf/$p" ] || curl -fsSL -o "mlperf/$p" "$MLP/$p"
done

[ -f acme_trace_kalos.csv ] || curl -fsSL -o acme_trace_kalos.csv https://raw.githubusercontent.com/InternLM/AcmeTrace/main/data/job_trace/trace_kalos.csv

$CLI data import philly-machines trace-data/cluster_machine_list --store "$STORE" --from 2017-11-08
$CLI data import philly-jobs trace-data/cluster_job_log --store "$STORE" --from 2017-11-08 --to 2017-11-15
$CLI data import philly-gpu philly-gpu-util-nov8-14.csv --store "$STORE" --from 2017-11-08 --to 2017-11-15 --machines 60 --step 10
$CLI data import azure-llm AzureLLMInferenceTrace_code.csv --store "$STORE" --pool azure-code
$CLI data import azure-llm AzureLLMInferenceTrace_conv.csv --store "$STORE" --pool azure-conv
for f in $(find mlperf -name mlperf_log_summary.txt); do $CLI data import mlperf "$f" --store "$STORE" --path "${f#mlperf/}" --t 1743552000; done
$CLI data import acme acme_trace_kalos.csv --store "$STORE" --cluster kalos
$CLI data summary --store "$STORE"
