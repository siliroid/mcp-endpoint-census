#!/usr/bin/env node
/*
 * diff-census.js — what CHANGED between two census runs.
 *
 * The snapshot is free and always will be. What decays is its accuracy: entries publish,
 * deployments vanish, things come back. A maintainer does not want the same 1,154-row CSV
 * every month — they want the twenty rows that moved. That delta is the product, and it is
 * the thing I told a company in writing that I sell, which is why it exists.
 *
 * FIVE CATEGORIES, and the last two are the ones nobody else reports:
 *   newly-broken     answered last time, does not now        <- the alert
 *   newly-recovered  broken last time, answers now           <- proof the check is worth having
 *   still-broken     broken in both runs                     <- the backlog, with an age
 *   new-endpoint     absent from the previous run entirely   <- someone published
 *   delisted         present before, gone from the registry  <- someone removed it
 *
 * ⛔ A ROW MOVING FROM `unknown` IS NOT A CHANGE IN THE WORLD. If I could not measure an
 * endpoint last run and can this one, that is a change in MY instrument, not in their
 * infrastructure, and reporting it as "newly broken" would be exactly the error I corrected
 * publicly today — my own load recorded as someone else's rot. Transitions involving
 * `unknown` on either side are counted separately and never alerted on.
 *
 * usage:
 *   node diff-census.js <old.json> <new.json> [--org smithery.ai] [--json]
 *   node diff-census.js --latest                # newest two in snapshots/
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SNAP = path.join(__dirname, 'snapshots');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const ORG = arg('org', null);
const AS_JSON = process.argv.includes('--json');

const BROKEN = new Set(['dead', 'not-mcp', 'alive-wrong-transport', 'flaky']);
const ALIVE = new Set(['alive-open', 'alive-gated']);
const cls = s => (BROKEN.has(s) ? 'broken' : ALIVE.has(s) ? 'alive' : 'unmeasured');

function loadPair() {
  if (process.argv.includes('--latest')) {
    const files = fs.readdirSync(SNAP).filter(f => f.endsWith('.json')).sort();
    if (files.length < 2) {
      console.error(`need two snapshots in ${SNAP}; found ${files.length}.`);
      console.error('a diff needs a previous run — take a baseline, probe again later, then diff.');
      process.exit(1);
    }
    return files.slice(-2).map(f => path.join(SNAP, f));
  }
  const [a, b] = process.argv.slice(2).filter(x => !x.startsWith('--'));
  if (!a || !b) { console.error('usage: diff-census.js <old.json> <new.json> | --latest'); process.exit(1); }
  return [a, b];
}

const index = (file) => {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = new Map();
  for (const e of d.endpoints) if (e.state) m.set(e.url, e);
  return { when: d.updated_at || d.verified_at || 'unknown', rows: m };
};

(function main() {
  const [fOld, fNew] = loadPair();
  const A = index(fOld), B = index(fNew);

  const match = u => !ORG || u.toLowerCase().includes(ORG.toLowerCase());

  const out = { newlyBroken: [], newlyRecovered: [], stillBroken: [], newEndpoint: [], delisted: [], measurementOnly: 0 };

  for (const [url, now] of B.rows) {
    if (!match(url)) continue;
    const before = A.rows.get(url);
    const cNow = cls(now.state);

    if (!before) {
      if (cNow !== 'unmeasured') out.newEndpoint.push({ url, state: now.state, servers: now.servers });
      continue;
    }
    const cWas = cls(before.state);

    // an instrument change is not a world change
    if (cWas === 'unmeasured' || cNow === 'unmeasured') { out.measurementOnly++; continue; }

    if (cWas === 'alive' && cNow === 'broken') {
      out.newlyBroken.push({ url, was: before.state, now: now.state, status: now.status, servers: now.servers });
    } else if (cWas === 'broken' && cNow === 'alive') {
      out.newlyRecovered.push({ url, was: before.state, now: now.state });
    } else if (cWas === 'broken' && cNow === 'broken') {
      out.stillBroken.push({ url, state: now.state, status: now.status });
    }
  }

  for (const [url, before] of A.rows) {
    if (!match(url)) continue;
    if (!B.rows.has(url)) out.delisted.push({ url, lastState: before.state });
  }

  if (AS_JSON) { console.log(JSON.stringify({ from: A.when, to: B.when, org: ORG, ...out }, null, 2)); return; }

  const L = [];
  L.push(`# Endpoint delta${ORG ? ` — ${ORG}` : ''}`);
  L.push('');
  L.push(`${path.basename(fOld)} → ${path.basename(fNew)}`);
  L.push('');
  L.push(`| change | count |`);
  L.push(`|---|---:|`);
  L.push(`| **newly broken** | ${out.newlyBroken.length} |`);
  L.push(`| newly recovered | ${out.newlyRecovered.length} |`);
  L.push(`| still broken | ${out.stillBroken.length} |`);
  L.push(`| newly published | ${out.newEndpoint.length} |`);
  L.push(`| delisted | ${out.delisted.length} |`);
  L.push('');
  L.push(`${out.measurementOnly} rows moved to or from unmeasurable and are excluded — that is a`);
  L.push(`change in the instrument, not in anyone's infrastructure.`);
  L.push('');

  if (out.newlyBroken.length) {
    L.push('## Newly broken');
    L.push('');
    for (const r of out.newlyBroken) {
      L.push(`- \`${r.url}\` — was \`${r.was}\`, now \`${r.now}\`${r.status ? ` (${r.status})` : ''}`);
      const n = [...new Set(r.servers || [])];
      if (n.length) L.push(`  claimed by ${n.map(x => `\`${x}\``).join(', ')}`);
    }
    L.push('');
  }
  if (out.newlyRecovered.length) {
    L.push('## Newly recovered');
    L.push('');
    for (const r of out.newlyRecovered) L.push(`- \`${r.url}\` — was \`${r.was}\`, now \`${r.now}\``);
    L.push('');
  }
  if (out.delisted.length) {
    L.push('## Delisted from the registry');
    L.push('');
    for (const r of out.delisted) L.push(`- \`${r.url}\` — last seen \`${r.lastState}\``);
    L.push('');
  }
  if (out.newEndpoint.length) {
    L.push(`## Newly published (${out.newEndpoint.length})`);
    L.push('');
    for (const r of out.newEndpoint.slice(0, 40)) L.push(`- \`${r.url}\` — \`${r.state}\``);
    if (out.newEndpoint.length > 40) L.push(`- …and ${out.newEndpoint.length - 40} more`);
    L.push('');
  }
  L.push(`Still broken: ${out.stillBroken.length}. Full rows in \`broken-rows.csv\`.`);

  console.log(L.join('\n'));
})();
