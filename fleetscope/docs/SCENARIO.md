# One scenario across the views

The Fleet graph, Cluster, Training and Inference views share one clock and one change set. A pool in the fleet graph can also take its capacity from a cluster workload, so a cluster decision shows up as an SLO breach.

## Shared clock

Moving the playhead in any view moves the others. The view bar shows the shared clock. The Cluster, Training and Inference views run for hours. A fleet run is a short window: when a pool follows a cluster workload, the window starts at that cluster hour, so the clock maps into it. Otherwise a clock past the end of the fleet run leaves the fleet playhead where it is.

## Fleet pools that follow a cluster workload

In a GPU pool's form, **Capacity follows cluster workload** picks an inference deployment from the Cluster tab's cluster, and **Starting at cluster hour** picks the window. FleetScope then:
1. runs the cluster and counts that deployment's ready replicas. Start-up time comes from the Inference tab: image pull, weight load and warm-up.
2. turns every shortfall against the replica target into an outage on the pool: the share of replicas not ready is the share of instances lost, rounded to 5%.
3. runs the fleet with those outages and compares against the pools as drawn.

The status line shows "linked to cluster". Example: in the Cluster tab, set the serving queue's priority below research (100 → 5). Link the Hybrid chat burst graph's on-prem pool to `chat-serving` from cluster hour 0.5. The pre-training gang preempts the chat replicas, and the fleet's SLO attainment falls from 57% to 27%, with 260 streams cut mid-answer.

## Change set and baseline for every view

**Pin all as baseline** pins each view's current setup. Fleet, Cluster and Training also pin their KPIs so later runs show deltas. After that, **N changes since baseline** lists every edit in every view, for example:

```
Fleet    On-prem H100: clusterWorkload — → chat-serving
Fleet    On-prem H100: clusterAtH 0 → 0.5
Cluster  serving: priority 100 → 5
```

**Reset every view to the baseline** restores them all. Moving a node on the canvas is not counted as a change.
