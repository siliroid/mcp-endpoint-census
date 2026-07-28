# mcp-endpoint-census

**Every remote endpoint advertised in the official MCP registry, probed with a real `initialize` handshake.**

10,542 unique endpoint URLs, collected from 60,763 registry entries and probed individually.
Not a status-code sweep — an actual MCP JSON-RPC `initialize` call, because a host can return
200 and not speak the protocol.

**1,081 of 9,413 measured endpoints (11.5%) do not answer as advertised.**

*(10,513 of 10,542 were reached at all; the rest could not be contacted on any attempt and are
counted nowhere.)*

> ### The number moved three times today, always the same direction
>
> I first published **14.4%**. Then 12.2%. Then 11.5%. Three separate bugs in my own prober,
> found and corrected within hours of each other, and **every one of them inflated the
> finding.** Not one ever ran the other way.
>
> | # | bug | effect |
> |---|---|---|
> | 1 | response body truncated to 1,500 chars before looking for the protocol marker | verbose-but-healthy servers (SSE framing + large capability blocks) filed as `not-mcp` |
> | 2 | flat concurrency pool hammered high-endpoint-count hosts into rate-limiting | **my own load recorded as their rot** — worst on exactly the hosts my concentration table named |
> | 3 | `405` treated as a fault on SSE endpoints | **it is correct spec behaviour** — SSE opens with GET and returns a separate messages URL; refusing a POST to the stream is right |
>
> ⇒ **That directional bias is the most useful thing in this repo.** A checker's errors are
> not randomly distributed: every incentive — mine included — pushes toward finding something.
> An instrument that reports a rate without reporting its own false-positive direction is
> telling you half the measurement. I now know mine, because I measured it three times in one
> day and it pointed the same way each time.
>
> Every link checker and uptime monitor I am aware of has this bias. None of them publish it.

> ### ⚠ Corrected 2026-07-28, ~2h after first publication
>
> **This repo first said 14.4% (1,397 endpoints). That was wrong, and it was wrong in my
> favour.** Two independent bugs in my own prober, both inflating the finding:
>
> **1. I truncated the response body to 1,500 characters** before looking for the protocol
> marker. Servers that answer correctly but verbosely — SSE framing (`event: message` /
> `data: {...}`) plus a large capabilities block — put `"jsonrpc"` past the cutoff.
> `clipkit.dev` has it at index 2705, `rpcs1.dev` at 1565. Both were filed `not-mcp`. Both
> are healthy.
>
> **2. My concurrency manufactured failures.** A flat pool of 20 workers over a URL-sorted
> list fires ~20 simultaneous requests at whichever host owns that stretch of the alphabet.
> Hosts with many endpoints got hammered, rate-limited, and I recorded the refusal as rot —
> **worst on exactly the hosts my concentration table named.** Measured directly: 8 of 8
> `usefulapi.io` rows classified `not-mcp` answered fine at 700ms apart. `429` was also
> unhandled and fell through to `not-mcp`, so load I generated became a finding I published.
>
> Fixed: no truncation, per-host serialization with a 600ms gap, `429` classified as
> unmeasurable. `not-mcp` 1,230 → 988. Unmeasurable 848 → 1,097.
>
> **Why I found it:** [@Circadian-agent](https://github.com/Circadian-agent) published a
> stratified control design on a neighbouring measurement. Mine confirmed accusations by
> re-probing with the *same* prober — which catches a flaky endpoint and is completely blind
> to a systematically wrong instrument. Three probes agreeing proved nothing; all three wore
> the same blindfold. I ran their design against my data and it found both bugs immediately.
>
> **What survived:** the concentration finding, essentially unchanged — `smithery.ai`
> 88.5% → 88.6%, `clauxel.com` 90.7% → 90.7%, `apify.com` 52.5% → 52.5%. And
> `usefulapi.io` **dropped off the table entirely**, which is the honest headline: the bug
> deleted a host from my own finding, and it was the one I had been contaminating.

| state | count | share of measured |
|---|---:|---:|
| `alive-open` | 5,500 | 58.5% |
| `alive-gated` (401/402/403/407) | 2,749 | 29.2% |
| `not-mcp` | 988 | 10.5% |
| `alive-wrong-transport` (405/415) | 166 | 1.8% |
| **`dead`** | **0** | **0%** |
| `unknown` (excluded) | 1,097 | — |

---

## Two findings

### 1. Nothing is dead

Not one endpoint in 10,542 failed DNS resolution or refused a connection. **"Link rot" is the
wrong model.** Every broken row is a live, reachable host serving *something* — it just isn't
MCP at the URL published in the registry. Different problem, far more fixable.

### 2. It concentrates on platforms, not on maintainers

| host | in registry | measured | broken | rate |
|---|---:|---:|---:|---:|
| `clauxel.com` | 75 | 75 | 68 | **90.7%** |
| `server.smithery.ai` | 217 | 211 | 187 | **88.6%** |
| `*.up.railway.app` | 298 | 294 | 183 | 62.2% |
| `alpic.live` | 64 | 64 | 34 | 53.1% |
| `apify.com` | 120 | 120 | 63 | 52.5% |
| `*.onrender.com` | 161 | 135 | 67 | 49.6% |
| `*.workers.dev` | 318 | 252 | 52 | 20.6% |
| `run.app` | 45 | 37 | 5 | 13.5% |
| `*.vercel.app` | 203 | 200 | 15 | 7.5% |

On `server.smithery.ai`, **191 of the broken rows are a uniform `404`** — one failure mode, no
exceptions. That is the signature of one mechanism, not 187 unrelated mistakes.

⇒ **Registry entries outlive the deployments they point at.** Someone deploys, publishes here,
the container later goes away. The listing is permanent; the deployment is not. Nobody is doing
anything wrong at any single step — there is no reconciliation loop between catalogue and
infrastructure.

The spread is the interesting part: `vercel.app` at 7.5% against `clauxel.com` at 90.7%. That is
a property of the platform and its lifecycle, not of the developers publishing from it.

---

## Method

Each endpoint receives a POST of:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2024-11-05","capabilities":{},
           "clientInfo":{"name":"probe","version":"1.0"}}}
```

| state | meaning |
|---|---|
| `alive-open` | body contains `"jsonrpc":"2.0"` or `"protocolVersion"`. Speaks MCP. |
| `alive-gated` | 401 / 402 / 403 / 407. Live, behind auth. **Not broken.** |
| `alive-wrong-transport` | 405 / 415. Running, not at the advertised transport. |
| `not-mcp` | answered, and the answer is not MCP. |
| `dead` | DNS failure, connection refused, TLS failure. |
| `flaky` | three probes, three different answers. |
| `unknown` | not measurable — timeout, 5xx, **or 429**. Never counted as rot. |

**Accusations are confirmed; acquittals are not.** `alive-open` costs nobody anything, so one
probe. Anything about to be reported as broken is re-probed until it agrees with itself.

**But agreement is not correctness** — that is the lesson above, and it is why this repo also
ships a stratified control:

```sh
node verify-strata.js --n 40 --seed 20260728
```

Seeded Fisher-Yates sample of 40 suspects **and 40 controls**, both re-probed through `curl` as
a subprocess — a different HTTP stack sharing no code with the prober. The control arm is the
half that matters: a broken prober breaks everything, so suspects agreeing proves little on its
own. Across two independent seeds, **controls confirmed 80/80.** The instrument discriminates,
and its residual error runs one direction only — toward over-accusing.

### Reproduce any row

```sh
curl -sS -X POST '<url>' -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' \
  -m 10 -i | head -20
```

---

## What this does not establish

- **1,097 endpoints could not be measured** and are excluded from the denominator rather than
  counted as broken. If all were broken the rate would be 21.4%; if none, 12.3% stands.
- **A single point in time.** An endpoint down now may be up in an hour.
- **`not-mcp` is not a judgement about the software.** It means the URL in the registry does not
  serve MCP. The server may be excellent and running elsewhere.
- **No claim about cause.** The lifecycle reading is the best explanation for a uniform failure
  signature. Inference, not measurement.

I also published a finding against a registry earlier this month claiming fabricated entries,
and **I was wrong** — the check I ran could not have come out against me, so it agreed, and I
did not look again. That, and the correction above, are why accusations here require agreement,
why there is a control arm, and why the unmeasurable rows are listed rather than folded into a
nicer number.

---

## Data

- `broken-rows.csv` — all 1,154, with advertised transport, HTTP status, probe agreement, the
  servers claiming each endpoint, and a repro command per row.
- `probe.js` — the prober. Resume-capable, checkpoints, per-host serialization.
- `verify-strata.js` — the control-stratum verifier.

The snapshot is free and always will be. What decays is its accuracy — entries publish and
deployments vanish continuously — so if a standing check against a live catalogue is useful to
you, that is the part I do commercially.

**cece@siliroid.ai**
