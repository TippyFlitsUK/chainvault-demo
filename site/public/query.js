import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const fmt = (n) => Number(n).toLocaleString();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
let loads = {}, db = null, conn = null, knownProviders = {};

// --- CAR decoding with per-block verification --------------------------------------------------
function varint(u8, off) { let r = 0n, s = 0n, i = off; for (;;) { const b = u8[i++]; r |= BigInt(b & 0x7f) << s; s += 7n; if (!(b & 0x80)) return [Number(r), i]; } }
async function decodeCar(u8, wantDigest) {
  let [hlen, p] = varint(u8, 0); p += hlen;
  const leaves = []; let blocks = 0, verified = 0, rootSeen = false, total = 0;
  while (p < u8.length) {
    const [blen, q] = varint(u8, p); p = q;
    const blockEnd = p + blen;
    let codec, digest;
    if (u8[p] === 0x12) { codec = 0x70; digest = u8.subarray(p + 2, p + 34); p += 34; }
    else { let v, c, mh, ml; [v, p] = varint(u8, p); [c, p] = varint(u8, p); [mh, p] = varint(u8, p); [ml, p] = varint(u8, p); codec = c; digest = u8.subarray(p, p + ml); p += ml; }
    const data = u8.subarray(p, blockEnd); p = blockEnd; blocks++;
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    if (h.length === digest.length && h.every((x, i) => x === digest[i])) verified++; else throw new Error(`block ${blocks} failed hash verification`);
    if (wantDigest && hex(h) === wantDigest) rootSeen = true;
    if (codec === 0x55) { leaves.push(data); total += data.length; }
  }
  const out = new Uint8Array(total); let o = 0; for (const l of leaves) { out.set(l, o); o += l.length; }
  return { bytes: out, blocks, verified, rootSeen };
}
function cidDigestHex(cid) {  // base32 CIDv1 -> multihash digest hex
  if (!cid.startsWith('b')) return null;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, value = 0; const out = [];
  for (const ch of cid.slice(1)) { const v = alphabet.indexOf(ch); if (v < 0) return null; value = (value << 5) | v; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  const u = new Uint8Array(out); let p = 0, x; [x, p] = varint(u, p); [x, p] = varint(u, p); [x, p] = varint(u, p); let ml; [ml, p] = varint(u, p);
  return hex(u.subarray(p, p + ml));
}
const place = (loc) => { const m = Object.fromEntries((loc || '').split(';').map((kv) => kv.split('=')).filter((x) => x.length === 2)); return [m.L, m.ST, m.C].filter(Boolean).join(', '); };

// --- 1. providers via IPNI ---------------------------------------------------------------------
async function findProviders() {
  const cid = $('cid').value.trim(); $('findstatus').textContent = 'asking cid.contact…'; $('providers').innerHTML = ''; loads = {};

  try {
    const r = await fetch(`https://cid.contact/cid/${cid}`, { headers: { accept: 'application/json' } });
    if (r.status === 404) { $('findstatus').textContent = 'no provider in IPNI holds this CID'; return; }
    const j = await r.json();
    const hosts = new Set();
    for (const pr of (j.MultihashResults?.[0]?.ProviderResults || [])) for (const a of (pr.Provider?.Addrs || [])) { const m = /^\/dns4?6?\/([^/]+)\/tcp\/(\d+)\/(https?)$/.exec(a); if (m) hosts.add(`${m[3]}://${m[1]}${(m[3] === 'https' && m[2] === '443') ? '' : ':' + m[2]}`); }
    if (!hosts.size) { $('findstatus').textContent = 'providers found but none with an HTTPS address'; return; }
    $('findstatus').textContent = `${hosts.size} provider${hosts.size === 1 ? '' : 's'} hold this CID`;
    $('providers').innerHTML = [...hosts].map((h) => {
      const host = h.replace(/^https?:\/\//, ''); const known = Object.values(knownProviders).find((p) => (p.service_url || '').includes(host));
      return `<div class="provcard"><div class="pname">${esc(known ? known.name : host)}</div><div class="phost">${esc(host)}</div><div class="ploc">${known ? esc(place(known.location)) : '&nbsp;'}</div><button data-host="${esc(h)}">Load from this provider</button><div class="pstatus" data-status="${esc(h)}"></div></div>`;
    }).join('');
    for (const b of $('providers').querySelectorAll('button')) b.onclick = () => loadFrom(b.dataset.host, cid);
  } catch (e) { $('findstatus').textContent = 'lookup failed: ' + e.message; }
}

// --- 2. load + verify --------------------------------------------------------------------------
function renderLoads() {
  const entries = Object.entries(loads); if (!entries.length) return;
  const shas = new Set(entries.map(([, l]) => l.sha)); const first = entries[0][1].sha;
  $('verdict').className = 'verdict ' + (shas.size === 1 ? 'ok' : 'bad');
  $('verdict').textContent = entries.length < 2 ? `Loaded from ${entries[0][0]}. Load from another provider to compare.` : shas.size === 1 ? `✓ ${entries.length} providers, one identical file: every copy hashes to ${first.slice(0, 16)}…` : `✗ copies differ: ${[...shas].map((x) => x.slice(0, 12)).join(' vs ')}`;
  $('loads').innerHTML = `<tr><th>provider</th><th>bytes</th><th>blocks verified</th><th>sha256</th><th>fetched</th><th>match</th></tr>` + entries.map(([h, l]) => `<tr><td>${esc(h)}</td><td>${fmt(l.bytes)}</td><td>${l.verified} / ${l.blocks}${l.rootSeen ? ' <span class="muted">· CID present</span>' : ''}</td><td class="mono">${l.sha}</td><td>${l.ms} ms</td><td class="${l.sha === first ? 'ok' : 'bad'}">${entries.length < 2 ? '–' : l.sha === first ? '✓ identical' : '✗ differs'}</td></tr>`).join('');
}
async function loadFrom(base, cid) {
  const status = document.querySelector(`[data-status="${base}"]`); const host = base.replace(/^https?:\/\//, '');
  status.className = 'pstatus'; status.textContent = 'fetching CAR…'; const t0 = performance.now();
  try {
    const r = await fetch(`${base}/ipfs/${cid}`, { headers: { accept: 'application/vnd.ipld.car' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const car = new Uint8Array(await r.arrayBuffer());
    status.textContent = `${fmt(car.length)} B CAR, verifying…`;
    const { bytes, blocks, verified, rootSeen } = await decodeCar(car, cidDigestHex(cid));
    const sha = hex(await crypto.subtle.digest('SHA-256', bytes));
    const ms = Math.round(performance.now() - t0);
    loads[host] = { sha, bytes: bytes.length, ms, blocks, verified, rootSeen };
    renderLoads();
    status.className = 'pstatus ok'; status.textContent = `✓ loaded · ${verified}/${blocks} blocks verified · ${ms} ms`;
    await ensureDb(); await db.registerFileBuffer('data.parquet', bytes);
    $('run').disabled = false; await runSql();
  } catch (e) { status.className = 'pstatus bad'; status.textContent = '✗ ' + e.message; }
}

// --- 3. query ----------------------------------------------------------------------------------
async function ensureDb() {
  if (db) return;
  $('sqlstatus').textContent = 'starting DuckDB…';
  const bundles = duckdb.getJsDelivrBundles(); const bundle = await duckdb.selectBundle(bundles);
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl); db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker); URL.revokeObjectURL(workerUrl); conn = await db.connect();
}
async function runSql() {
  if (!conn) return; $('sqlstatus').textContent = 'running…'; const t0 = performance.now();
  try {
    const res = await conn.query($('sql').value);
    const fields = res.schema.fields; const cols = fields.map((f) => f.name); const rows = res.toArray().map((r) => r.toJSON());
    const isTime = (f) => /Date|Timestamp/i.test(String(f.type));
    const show = (f, v) => v == null ? '' : isTime(f) ? new Date(Number(v)).toISOString().slice(0, String(f.type).includes('Date') ? 10 : 19).replace('T', ' ') : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : String(v);
    $('results').innerHTML = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>` + rows.map((r) => `<tr>${fields.map((f) => `<td>${esc(show(f, r[f.name]))}</td>`).join('')}</tr>`).join('');
    $('sqlstatus').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} · ${Math.round(performance.now() - t0)} ms`;
  } catch (e) { $('sqlstatus').textContent = 'error: ' + e.message; $('results').innerHTML = ''; }
}
$('find').onclick = findProviders; $('run').onclick = runSql;
$('sql').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runSql(); });
fetch('/api/providers').then((r) => r.json()).then((p) => { knownProviders = Object.fromEntries((p.providers || []).map((x) => [x.id, x])); }).catch(() => {}).then(findProviders);
