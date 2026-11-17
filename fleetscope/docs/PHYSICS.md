# Richer physics

Knobs that change how the simulator behaves, beyond the original serving and training model. Each one defaults to off, or to the original behaviour, so existing results are unchanged.

## Serving

| Feature | Where | Model |
| --- | --- | --- |
| **Prefix-cache locality** | Router → Prefix cache | *Ideal* (default): every cached prefix is found. *Cache-oblivious routing*: a returning session's prefix lives on the instance that served its last turn. Landing on another instance or pool keeps only the shared system prompt, and the prefix can be evicted under KV pressure (more likely above 50% use). *KV-aware routing* (llm-d, Dynamo): sessions stay on the pool and instance that hold their prefix while it has room. |
| **CPU KV offload** | Pool → CPU KV offload, link GB/s | Prefixes survive in host memory instead of being evicted, but a hit loads them back over the offload link before prefill (LMCache-style). |
| **Speculative decoding** | Model → draft tokens, acceptance | Each verification step accepts (1 − αᵏ⁺¹)/(1 − α) tokens per sequence. It costs a draft pass per token (6% of the fixed step each) and verifies k + 1 tokens per sequence. That pays off at small batches; at large batches the extra compute eats the gain. |
| **LoRA adapters** | Pool → adapters in traffic, adapters per batch | Each adapter resident in a batch adds 4% to the per-sequence decode cost. With more adapters than slots, the batch is capped at max batch × slots ÷ adapters. |
| **MoE all-to-all** | Automatic for MoE models | Each token's hidden state goes to its experts and back at every layer. That runs over NVLink inside a node and InfiniBand when an instance spans nodes, and is added to the per-sequence decode cost. |

On the coding-agent fleet with 14 on-prem instances:
- **Ideal prefix caching:** 98% meet the SLO.
- **Cache-oblivious routing:** 10%. Only 16% of prompt tokens are served from cache.
- **KV-aware routing:** 72%.
- **KV-aware routing plus 512 GB of CPU offload:** 78%, with 75% of prompt tokens served from cache.

With speculative decoding (3 drafts, 70% acceptance) on 12 instances of the burst graph, TPOT p99 falls from 38 ms to 20 ms.

## Training

| Feature | Model |
| --- | --- |
| **Elastic** | After a fault with no hot spare, the job reshards and continues without that node until it is repaired, at proportionally lower throughput, instead of waiting. |
| **Power cap** | Compute throughput scales with (cap)^0.35, since clocks drop less than power. Energy is reported for every run. |
| **Two sites** | The reduced gradients also cross the WAN once per step (hierarchical all-reduce); only the share not overlapped with compute is exposed. |

On the default 160-GPU job:
- **Elastic vs no spare:** with no hot spare, being elastic trains 5.6B tokens instead of 3.7B.
- **Power cap:** an 80% cap uses 17% less energy for 3.5% fewer tokens.
- **Two sites:** splitting across sites joined by 100 Gb/s makes gradient sync the bottleneck.
