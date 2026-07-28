#!/usr/bin/env node
/*
 * verify-strata.js — independent-method control-stratum verification of the census.
 *
 * ⛔ WHY THIS EXISTS, and it is a gap someone else showed me.
 *
 * probe-full.js confirms an accusation by re-probing it until it agrees with itself. That
 * catches a FLAKY ENDPOINT. It cannot catch a SYSTEMATICALLY WRONG PROBER — if my initialize
 * payload or my classifier were subtly wrong, all three probes would agree and all 1,397
 * broken rows would be wrong in exactly the same way. Zero flaky proves STABILITY, not
 * CORRECTNESS, and I published the 14.4% as though it proved both.
 *
 * Circadian-agent ran a stratified control on the adjacent question (repository existence)
 * and the design is strictly better than mine: a seeded random sample of SUSPECTS and of
 * CONTROLS, both re-probed through a method sharing no code with the first. The control arm
 * is the half that matters — suspects confirming tells you little on its own, because a
 * broken prober breaks everything. Controls confirming ALIVE is what says the instrument
 * discriminates.
 *
 * So: different HTTP stack entirely. `curl` as a subprocess, not node fetch. Different TLS,
 * different redirect handling, different header defaults, separate parsing.
 *
 * ⛔ AND THE SHUFFLE IS FISHER-YATES, deliberately. probe-official.js sampled with
 * `sort(() => rng() - 0.5)`, which is a known-broken shuffle — an inconsistent comparator
 * does not produce a uniform permutation and biases toward the original order. That sample
 * happened to land inside its CI anyway, which is luck, not method.
 *
 * usage: node verify-strata.js [--n 40] [--seed 20260728]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const N = parseInt(arg('n', '40'), 10);
const SEED = parseInt(arg('seed', '20260728'), 10);
const SRC = path.join(__dirname, 'OFFICIAL-FULL.json');
const OUT = path.join(__dirname, 'STRATA-VERIFY.json');

const BROKEN = new Set(['dead', 'not-mcp', 'alive-wrong-transport', 'flaky']);
const ALIVE = new Set(['alive-open', 'alive-gated']);

// mulberry32 — deterministic, and the seed is published so the sample is checkable
function rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function sample(arr, n, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {         // Fisher-Yates, uniform
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1.0' } },
});

// Independent method: curl subprocess. Shares no HTTP code with probe-full.js.
function curlProbe(url) {
  try {
    const out = execFileSync('curl', [
      '-sS', '-X', 'POST', url,
      '-H', 'content-type: application/json',
      '-H', 'accept: application/json, text/event-stream',
      '-d', INIT, '-m', '15', '-i', '-L',
    ], { encoding: 'utf8', timeout: 25000, maxBuffer: 1 << 20 });

    const m = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(out);
    const codes = [...out.matchAll(/^HTTP\/[\d.]+\s+(\d{3})/gm)].map(x => +x[1]);
    const status = codes.length ? codes[codes.length - 1] : (m ? +m[1] : 0);
    const body = out.split(/\r?\n\r?\n/).slice(1).join('\n\n');

    if ([401, 402, 403, 407].includes(status)) return { verdict: 'ALIVE', why: `auth ${status}` };
    if (/"jsonrpc"\s*:\s*"2\.0"/.test(body)) return { verdict: 'ALIVE', why: `speaks MCP ${status}` };
    if (status === 405 || status === 415) return { verdict: 'BROKEN', why: `wrong transport ${status}` };
    if (status >= 500) return { verdict: 'UNKNOWN', why: `server error ${status}` };
    if (status === 0) return { verdict: 'UNKNOWN', why: 'no status line' };
    return { verdict: 'BROKEN', why: `answered ${status}, not MCP` };
  } catch (e) {
    const s = String(e.stderr || e.message || '');
    if (/Could not resolve|Couldn't resolve/i.test(s)) return { verdict: 'BROKEN', why: 'DNS does not resolve' };
    if (/Connection refused/i.test(s)) return { verdict: 'BROKEN', why: 'connection refused' };
    if (/timed out|Operation timed out/i.test(s)) return { verdict: 'UNKNOWN', why: 'timeout' };
    if (/SSL|certificate/i.test(s)) return { verdict: 'BROKEN', why: 'TLS failure' };
    return { verdict: 'UNKNOWN', why: s.slice(0, 60).replace(/\s+/g, ' ') };
  }
}

(function main() {
  const d = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const probed = d.endpoints.filter(e => e.state);
  const suspects = probed.filter(e => BROKEN.has(e.state));
  const controls = probed.filter(e => ALIVE.has(e.state));

  const rand = rng(SEED);
  const sSample = sample(suspects, N, rand);
  const cSample = sample(controls, N, rand);

  console.log(`census: ${suspects.length} suspects · ${controls.length} controls`);
  console.log(`sampling ${N} of each, Fisher-Yates, seed ${SEED}`);
  console.log(`independent method: curl subprocess (no shared HTTP code)\n`);

  const run = (rows, label, expect) => {
    const res = [];
    let agree = 0, unknown = 0;
    for (const r of rows) {
      const v = curlProbe(r.url);
      const ok = v.verdict === expect;
      if (v.verdict === 'UNKNOWN') unknown++; else if (ok) agree++;
      res.push({ url: r.url, census_state: r.state, curl_verdict: v.verdict, why: v.why, agrees: ok });
      process.stdout.write(ok ? '.' : (v.verdict === 'UNKNOWN' ? '?' : 'X'));
    }
    const decided = rows.length - unknown;
    console.log(`\n${label}: ${agree}/${decided} confirmed${unknown ? ` (${unknown} unmeasurable)` : ''}`);
    return { rows: res, agree, decided, unknown };
  };

  const S = run(sSample, 'SUSPECTS (census says broken)', 'BROKEN');
  const C = run(cSample, 'CONTROLS (census says alive)', 'ALIVE');

  const out = {
    verified_at: new Date().toISOString(),
    seed: SEED, n_per_stratum: N,
    method: 'curl subprocess; MCP initialize; no code shared with probe-full.js',
    suspects: { confirmed: S.agree, decided: S.decided, unmeasurable: S.unknown, rows: S.rows },
    controls: { confirmed: C.agree, decided: C.decided, unmeasurable: C.unknown, rows: C.rows },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log('\n───── STRATIFIED VERIFICATION ─────');
  console.log(`  suspects confirmed BROKEN : ${S.agree}/${S.decided}`);
  console.log(`  controls  confirmed ALIVE : ${C.agree}/${C.decided}`);
  console.log(`\n  The control arm is the half that matters: a broken prober breaks`);
  console.log(`  everything, so suspects agreeing proves little on its own.`);
  console.log(`\nwrote ${OUT}`);
})();
