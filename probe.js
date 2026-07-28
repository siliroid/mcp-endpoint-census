#!/usr/bin/env node
/*
 * probe-full.js — the row-by-row audit. THE DELIVERABLE, not the advertisement.
 *
 * probe-official.js answers "what is the ecosystem RATE" from a 1,200 sample and that
 * number is free. This answers "WHICH OF YOUR ROWS ARE BROKEN", which is the thing a
 * registry maintainer actually pays for, because it is the only version they can act on.
 *
 * THREE THINGS IT DOES THAT THE SAMPLER DOES NOT, each one learned the expensive way:
 *
 *  1. RESUMES. Reads the endpoint list already collected — no re-walk of 700 pages — and
 *     skips any row that already carries a state. A long run that has to start over is a
 *     long run that never finishes.
 *
 *  2. CHECKPOINTS. Writes every CHECKPOINT completions. The sampler writes once at the
 *     end; at 9,432 endpoints that is an hour of work destroyed by one thrown exception.
 *
 *  3. CONFIRMS THE ACCUSATIONS, NOT THE ACQUITTALS. A row that probes 'alive-open' is a
 *     row I am saying nothing about — one probe is fine. A row I am about to report as
 *     dead / not-mcp / wrong-transport is an ACCUSATION against a maintainer's catalogue,
 *     and I have published a false one of those before: fourteen entries called fabricated
 *     that were all real, because I ran a check that could not have come out against me.
 *     So anything landing in a column that costs someone something gets re-probed until
 *     it agrees with itself, and if it does NOT agree it is downgraded to 'flaky' and
 *     reported as flaky. An endpoint that answers differently on two tries is a genuine
 *     finding in its own right and a much fairer one than picking whichever result I liked.
 *
 * usage:
 *   node probe-full.js                 # resume the full sweep
 *   node probe-full.js --retry-unknown # second pass over timeouts, longer deadline
 *   node probe-full.js --limit 500     # bounded run
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'OFFICIAL-REMOTES.json');
const OUT = path.join(__dirname, 'OFFICIAL-FULL.json');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const RETRY_UNKNOWN = process.argv.includes('--retry-unknown');
const LIMIT = parseInt(arg('limit', '0'), 10);
const CONC = parseInt(arg('conc', '12'), 10);
const CHECKPOINT = parseInt(arg('checkpoint', '200'), 10);
const TIMEOUT = parseInt(arg('timeout', RETRY_UNKNOWN ? '20000' : '8000'), 10);

// states that constitute a claim AGAINST the catalogue -> require agreement
const ACCUSATIONS = new Set(['dead', 'not-mcp', 'alive-wrong-transport']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'unreached-probe', version: '1.0.0' },
  },
};

async function probeOnce(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INIT), signal: ac.signal, redirect: 'follow',
    });
    const status = r.status;
    // 402 is auth too — a live commercial service behind a paywall. Enumerating 401/403
    // from memory once put a working product in my broken column.
    if ([401, 402, 403, 407].includes(status)) return { state: 'alive-gated', status };
    const body = (await r.text()).slice(0, 1500);
    if (/"jsonrpc"\s*:\s*"2\.0"/.test(body)) return { state: 'alive-open', status };
    if (status >= 500) return { state: 'unknown', status, note: 'server error' };
    if (status === 405 || status === 415) return { state: 'alive-wrong-transport', status };
    return { state: 'not-mcp', status };
  } catch (e) {
    const m = String(e.message || e);
    if (/abort/i.test(m)) return { state: 'unknown', note: 'timeout' };
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return { state: 'dead', note: 'DNS does not resolve' };
    if (/ECONNREFUSED/i.test(m)) return { state: 'dead', note: 'connection refused' };
    if (/certificate|SSL|TLS/i.test(m)) return { state: 'dead', note: 'TLS failure: ' + m.slice(0, 40) };
    return { state: 'unknown', note: m.slice(0, 60) };
  } finally { clearTimeout(t); }
}

// One probe for anything harmless. Agreement required before I accuse a row of being broken.
async function probe(url) {
  const first = await probeOnce(url);
  if (!ACCUSATIONS.has(first.state)) return { ...first, probes: 1 };

  await sleep(400);
  const second = await probeOnce(url);
  if (second.state === first.state) return { ...first, probes: 2, confirmed: true };

  // disagreed — one more, and majority wins; no majority means genuinely flaky
  await sleep(800);
  const third = await probeOnce(url);
  const seen = [first.state, second.state, third.state];
  const tally = {};
  for (const s of seen) tally[s] = (tally[s] || 0) + 1;
  const [top, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (n >= 2) {
    const win = [first, second, third].find(x => x.state === top);
    return { ...win, probes: 3, confirmed: true, disagreed: seen.join('/') };
  }
  return { state: 'flaky', probes: 3, note: 'three probes, three answers: ' + seen.join('/') };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function load() {
  if (fs.existsSync(OUT)) {
    const d = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    console.log(`resuming from ${path.basename(OUT)}`);
    return d;
  }
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  console.log(`seeding from ${path.basename(SRC)} (${src.endpoints.length} endpoints, ` +
    `${src.endpoints.filter(e => e.state).length} already carry a sampled result)`);
  return {
    started_at: new Date().toISOString(),
    source: src.source,
    population: src.endpoints.length,
    method: 'MCP initialize handshake over JSON-RPC; accusations require agreement across probes',
    endpoints: src.endpoints.map(e => ({ ...e })),
  };
}

function tally(endpoints) {
  const c = {};
  for (const e of endpoints) c[e.state || '(unprobed)'] = (c[e.state || '(unprobed)'] || 0) + 1;
  return c;
}

function save(data) {
  data.updated_at = new Date().toISOString();
  data.counts = tally(data.endpoints);
  data.probed = data.endpoints.filter(e => e.state).length;
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
}

(async () => {
  const data = load();

  let todo = RETRY_UNKNOWN
    ? data.endpoints.filter(e => e.state === 'unknown' || e.state === 'flaky')
    : data.endpoints.filter(e => !e.state);

  if (LIMIT && LIMIT < todo.length) todo = todo.slice(0, LIMIT);

  console.log(`\nmode: ${RETRY_UNKNOWN ? 'RETRY UNKNOWN/FLAKY' : 'full sweep'} · timeout ${TIMEOUT}ms · conc ${CONC}`);
  console.log(`to probe this run: ${todo.length}\n`);
  if (!todo.length) { console.log('nothing to do.'); save(data); return; }

  const t0 = Date.now();
  let done = 0, accusations = 0;

  await pool(todo, CONC, async (r) => {
    const res = await probe(r.url);
    // Object.assign merges — it does not delete. Without this, a row that timed out and
    // then retried clean keeps note:'timeout' sitting next to state:'alive-open', and the
    // buyer reads a self-contradicting row. Clear the result keys before writing the new one.
    for (const k of ['state', 'status', 'note', 'probes', 'confirmed', 'disagreed']) delete r[k];
    Object.assign(r, res, { probed_at: new Date().toISOString() });
    if (ACCUSATIONS.has(res.state)) accusations++;
    if (++done % CHECKPOINT === 0) {
      save(data);
      const rate = done / ((Date.now() - t0) / 1000);
      const eta = ((todo.length - done) / rate / 60).toFixed(0);
      console.log(`  ${done}/${todo.length} · ${rate.toFixed(1)}/s · ~${eta}m left · ${accusations} findings`);
    }
  });

  save(data);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n───── FULL AUDIT (${secs}s) ─────`);
  const counts = tally(data.endpoints);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${String(v).padStart(6)}  ${(v / data.endpoints.length * 100).toFixed(1)}%`);
  }
  console.log(`\nwrote ${OUT}`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
