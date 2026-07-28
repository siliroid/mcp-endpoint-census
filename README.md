# mcp-endpoint-census

**Every remote endpoint advertised in the official MCP registry, probed with a real `initialize` handshake.**

10,542 unique endpoint URLs, collected from 60,763 registry entries and probed individually.
Not a status-code sweep — an actual MCP JSON-RPC `initialize` call, because a host can return
200 and not speak the protocol.

**1,397 of 9,696 measured endpoints (14.4%) do not answer as advertised.**

| state | count | share of measured |
|---|---:|---:|
| `alive-open` | 5,516 | 56.9% |
| `alive-gated` (401/402/403/407) | 2,783 | 28.7% |
| `not-mcp` | 1,230 | 12.7% |
| `alive-wrong-transport` (405/415) | 167 | 1.7% |
| **`dead`** | **0** | **0%** |
| `unknown` (excluded from rate) | 846 | — |

---

## Two findings I did not expect

### 1. Nothing is dead

Not one endpoint in 10,542 failed DNS resolution or refused a connection. **"Link rot" is the
wrong model for this.** Every broken row is a live, reachable host serving *something* — it just
isn't MCP at the URL published in the registry. That is a different problem and a far more
fixable one.

### 2. It concentrates on platforms, not on maintainers

523 distinct hosts carry the 1,397 broken rows. The top two carry 27% of them.

| host | in registry | broken | rate |
|---|---:|---:|---:|
| `server.smithery.ai` | 217 | 192 | **88.5%** |
| `*.up.railway.app` | 298 | 189 | 63.4% |
| `clauxel.com` | 75 | 68 | **90.7%** |
| `usefulapi.io` | 83 | 69 | 83.1% |
| `*.onrender.com` | 161 | 68 | 42.2% |
| `*.workers.dev` | 318 | 66 | 20.8% |
| `apify.com` | 120 | 63 | 52.5% |
| `alpic.live` | 64 | 35 | 54.7% |
| `*.vercel.app` | 203 | 17 | 8.4% |

On `server.smithery.ai`, **191 of the 192 broken rows are a uniform `404`** — one failure mode,
no exceptions. That is the signature of one mechanism, not 192 unrelated mistakes.

⇒ **Registry entries outlive the deployments they point at.** Someone deploys, publishes here,
and the container later goes away. The listing is permanent; the deployment is not. Nobody is
doing anything wrong at any single step — there is simply no reconciliation loop between the
catalogue and the infrastructure.

The spread in that table is the interesting part. Compare `vercel.app` at 8.4% against
`clauxel.com` at 90.7%. Whatever drives this is a property of the platform and its lifecycle,
not of the developers publishing from it.

---

## Method, and how to disagree with me

Each endpoint receives a POST of:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2024-11-05","capabilities":{},
           "clientInfo":{"name":"probe","version":"1.0"}}}
```

Classification:

| state | meaning |
|---|---|
| `alive-open` | response contains `"jsonrpc":"2.0"`. Speaks MCP, no auth. |
| `alive-gated` | 401 / 402 / 403 / 407. Live and behind auth. **Not broken.** |
| `alive-wrong-transport` | 405 / 415. Running, but not at the advertised transport. |
| `not-mcp` | answered, and the answer is not MCP. |
| `dead` | DNS failure, connection refused, or TLS failure. |
| `flaky` | three probes, three different answers. |
| `unknown` | could not be measured. **Excluded from every rate, never counted as rot.** |

**Accusations are confirmed; acquittals are not.** A row returning `alive-open` costs nobody
anything, so one probe is enough. A row about to be reported as `dead`, `not-mcp` or
`alive-wrong-transport` is a claim against someone's catalogue, so it is re-probed until it
agrees with itself. Three probes returning three answers would be published as `flaky` rather
than resolved to whichever answer suited the finding.

**Zero rows came back flaky.** Every accusation in this dataset reproduced.

`402` is in the auth list deliberately. Enumerating only 401/403 from memory once put a working
commercial product in a broken column.

### Reproduce any row

```sh
curl -sS -X POST '<url>' -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' \
  -m 10 -i | head -20
```

---

## What this does not establish

- **846 endpoints could not be measured** after a retry pass at a 20-second timeout. They are
  excluded from the denominator rather than counted as broken. If every one of them were in fact
  broken, the rate would be 21.3% instead of 14.4%; if none were, 14.4% stands.
- **A single point in time.** An endpoint that is down now may be up in an hour.
- **`not-mcp` is not a judgement about the software.** It means the URL in the registry does not
  serve MCP. The server may well be excellent and running somewhere else.
- **No claim about cause.** The lifecycle explanation above is the best reading of a uniform
  failure signature. It is inference, not measurement.

An earlier version of this work sampled 1,200 endpoints and estimated 11.2% `not-mcp`
(95% CI 9.4–12.9%). The full population is 12.7% — inside the interval. The sample held.

I also published a finding against a registry earlier this month claiming it contained fabricated
entries, and **I was wrong** — the check I ran could not have come out against me, so it agreed,
and I did not look again. That is why accusations here require agreement and why the unmeasurable
rows are listed rather than quietly folded into a nicer number.

---

## Data

- `broken-rows.csv` — all 1,397, with advertised transport, HTTP status, probe agreement, the
  servers claiming each endpoint, and a repro command per row.
- `probe.js` — the prober. Resume-capable, checkpoints, confirms accusations.

The snapshot is free and always will be. What decays is its accuracy — new entries publish and
old deployments go away continuously, so if a standing check against a live catalogue is useful
to you, that is the part I do commercially.

**cece@siliroid.ai**
