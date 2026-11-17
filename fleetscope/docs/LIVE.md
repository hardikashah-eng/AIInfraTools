# Live twin: forecast, predicted breaches, prediction vs reality

The live twin forecasts traffic from metrics history, runs the forecast through a graph, and reports when and where the SLO would break. A typical alert reads: "SLO breaches 11:42–14:57: in the worst minute 100% of answers stream slower than the TPOT target. Where: On-prem H100, decode batches too large."

## How it works

1. **History**: request rate (and optionally prompt and generation token rates) from Prometheus, by default:
   `sum(rate(vllm:request_success_total[5m]))`, `sum(rate(vllm:prompt_tokens_total[5m]))`, `sum(rate(vllm:generation_tokens_total[5m]))`, eight days at five-minute steps.
2. **Forecast**: additive Holt-Winters with a daily season when there are two days or more, otherwise a level and trend. The 80% band widens with the horizon. On the sample week, six-hour forecasts are off by 9.8% on average (MAPE), and 92% of actual points fall inside the band (15 backtests).
3. **Projection**: the graph's first traffic source replays Poisson arrivals at the forecast rate (expected, or the upper band for a cautious view). Token sizes come from the recent token rates.
4. **Alerts**: minutes where over 10% of first tokens miss TTFT or over 10% of answers miss TPOT, merged across gaps of up to 3 minutes and kept when 2 minutes or longer. Each alert names the worst minute, the p99, and the node blamed for most of the breach.
5. **Prediction vs reality**: forecasting from a time before the end of the history scores the forecast against what actually happened (MAPE and band coverage).

## In the browser

**Live** in the fleet toolbar:
- **History:** the sample week, a Prometheus URL (the server must allow cross-origin requests from the page), or an exported file.
- **Settings:** when to forecast from, hours ahead, expected or upper band, and the clock's UTC offset.
- **Result:** a card with history, forecast and band, what actually happened, predicted breaches, and the prediction-vs-reality score.
- **Play the projection on the canvas** swaps the Trace replay node to the forecast so you can watch it.

In the sample (forecast from 9:00, six hours, upper band), the expected forecast ran 14% low on this morning: actual traffic tracked the upper band. That band predicts the on-prem pool's decode batches growing too large from 11:42.

## On a schedule

```bash
# every 5 minutes from cron or a Kubernetes CronJob
node tools/live-twin.mjs --prom http://prometheus:9090 --graph my-graph.json --hours 4 --band hi \
  --utc-offset -8 --webhook "$SLACK_WEBHOOK"            # or --webhook-kind lark with a Lark bot webhook
node tools/live-twin.mjs --prom http://prometheus:9090 --export history.json   # save history for the browser
node tools/live-twin.mjs --history history.json --now 2026-11-17T17:00:00Z    # backtest a past morning
```

`--graph` takes the JSON from **Copy graph JSON**. Without it, the Hybrid chat burst template is used. The exit code is 1 when breaches are predicted, so a scheduler can page on it. `--json` prints the forecast, the projection and the alerts as JSON.
