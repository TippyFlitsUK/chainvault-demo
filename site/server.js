// ChainVault demo server: static site + JSON state + rehydration log stream. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const { CarLeaves } = require('./car-leaves.js');

const PORT = parseInt(process.env.PORT || '3860', 10);
const DATA = process.env.CV_DATA || path.join(process.env.HOME, 'chainvault');
const PUBLIC = path.join(__dirname, 'public');
const REHYDRATE = process.env.CV_REHYDRATE || path.join(__dirname, '..', 'archiver', 'rehydrate.py');
const REHYDRATE_TOKEN = process.env.CV_REHYDRATE_TOKEN || '';
const REHYDRATE_PROVIDER = process.env.CV_REHYDRATE_PROVIDER || '';
const REHYDRATE_LOG = path.join(DATA, 'rehydrate.log');
const PARAMS_STATE = path.join(DATA, 'params_state.json');
const IPFS_CACHE = path.join(DATA, 'ipfs_cache.json');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Range, Content-Type', 'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, X-Proof-Param-Digest, X-Snapshot-Height, X-Snapshot-Sha256, X-Manifest-Cid, X-Served-From' };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const PIDFILE = path.join(DATA, 'rehydrate.pid');

function runningPid() {
  try {
    const pid = parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10);
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

function startRehydrate(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!REHYDRATE_TOKEN || auth !== `Bearer ${REHYDRATE_TOKEN}`) return sendJson(res, 401, { error: 'unauthorised' });
  const pid = runningPid();
  if (pid) return sendJson(res, 409, { error: 'already running', pid });
  fs.mkdirSync(DATA, { recursive: true });
  const out = fs.openSync(REHYDRATE_LOG, 'w');
  const args = ['-f', 'python3', REHYDRATE, '--workdir', DATA, '--latest', '--discard', ...(REHYDRATE_PROVIDER ? ['--provider-id', REHYDRATE_PROVIDER] : [])];
  // setsid -f forks the run off to init so a restart of this server (PM2 kills by process tree) cannot reach it;
  // the script writes its own pid into PIDFILE
  try { fs.unlinkSync(PIDFILE); } catch {}
  const child = spawn('setsid', args, { stdio: ['ignore', out, out], env: process.env });
  child.on('exit', () => fs.closeSync(out));
  sendJson(res, 202, { started: true });
}

function streamLog(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*' });
  let pos = 0;
  const send = () => {
    let st; try { st = fs.statSync(REHYDRATE_LOG); } catch { return; }
    if (st.size < pos) { pos = 0; res.write('event: reset\ndata: {}\n\n'); }
    if (st.size === pos) return;
    const fd = fs.openSync(REHYDRATE_LOG, 'r');
    const buf = Buffer.alloc(st.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos = st.size;
    for (const line of buf.toString('utf8').split('\n')) if (line) res.write(`data: ${JSON.stringify(line)}\n\n`);
  };
  send();
  const t = setInterval(() => { send(); res.write(`: ping ${runningPid() ? 'running' : 'idle'}\n\n`); }, 1000);
  req.on('close', () => clearInterval(t));
}

function providerUrl(id) {
  const pr = (readJson(path.join(DATA, 'providers.json'), { providers: [] }).providers || []).find((p) => p.id === id);
  return pr ? pr.service_url.replace(/\/$/, '') : null;
}

// Stream a file back out of its pieces on the SP, byte-exact, with Range support. Used for
// /ipfs/<cid> (proof parameters, what a node's IPFS_GATEWAY points at) and /snapshot/<height|latest>
// (Forest imports straight from the URL). Nothing is cached on this box.
function streamParts(req, res, partsIn, filename, extraHeaders, sourcesOf, wantProvider) {
  sourcesOf = sourcesOf || ((part) => (part.copies || []).map((c) => ({ provider_id: c.provider_id, url: providerUrl(c.provider_id) ? `${providerUrl(c.provider_id)}/piece/${part.piece_cid}` : null })).filter((x) => x.url));
  const parts = [...partsIn].sort((a, b) => a.index - b.index);
  const total = parts.reduce((a, p) => a + p.size, 0);
  let start = 0, end = total - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = parseInt(range[1], 10); if (range[2]) end = Math.min(parseInt(range[2], 10), total - 1); }
    else { start = Math.max(0, total - parseInt(range[2], 10)); }
    if (start > end || start >= total) { res.writeHead(416, { 'content-range': `bytes */${total}` }); return res.end(); }
    status = 206;
  }
  const headers = {
    'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
    'content-disposition': `inline; filename="${filename}"`, 'cache-control': 'no-cache', ...CORS, ...extraHeaders,
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  const preferred = REHYDRATE_PROVIDER ? parseInt(REHYDRATE_PROVIDER, 10) : null;
  const matches = (c) => wantProvider && (String(c.provider_id) === wantProvider || (c.url || '').includes(`//${wantProvider}`) || (providerUrl(c.provider_id) || '').includes(`//${wantProvider}`));
  const firstSources = parts.length ? sourcesOf(parts[0]).filter((c) => !wantProvider || matches(c)) : [];
  if (wantProvider && !firstSources.length) { res.writeHead(404, { 'content-type': 'text/plain', ...CORS }); return res.end(`provider ${wantProvider} does not hold this content\n`); }
  const chosen = firstSources.sort((a, b) => (a.provider_id === preferred ? -1 : 0) - (b.provider_id === preferred ? -1 : 0))[0];
  if (chosen) headers['x-served-from'] = (chosen.url || `${providerUrl(chosen.provider_id)}`).replace(/^https?:\/\//, '').split('/')[0];
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  let offset = 0, i = 0, closed = false;
  req.on('close', () => { closed = true; });
  const next = () => {
    if (closed) return;
    if (i >= parts.length || offset > end) return res.end();
    const part = parts[i++];
    const pStart = offset, pEnd = offset + part.size - 1; offset += part.size;
    if (pEnd < start) return next();
    let copies = sourcesOf(part).sort((a, b) => (a.provider_id === preferred ? -1 : 0) - (b.provider_id === preferred ? -1 : 0));
    if (wantProvider) copies = copies.filter(matches);  // an explicit choice is honoured strictly: no silent fallback to another provider
    const tryCopy = (k) => {
      if (k >= copies.length) { res.destroy(new Error(`no provider served part ${part.index}`)); return; }
      const up = https.get(copies[k].url, { headers: { 'user-agent': 'chainvault-site/0.1', accept: 'application/vnd.ipld.car, */*' } }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return tryCopy(k + 1); }
        let pos = pStart;
        const leaves = r.pipe(new CarLeaves());
        leaves.on('data', (d) => {
          if (closed) return leaves.destroy();
          let a = 0, b = d.length;
          if (pos + b - 1 < start) { pos += b; return; }
          if (pos < start) a = start - pos;
          if (pos + b - 1 > end) b = end - pos + 1;
          pos += d.length;
          if (b > a && !res.write(d.subarray(a, b))) { leaves.pause(); res.once('drain', () => leaves.resume()); }
        });
        leaves.on('end', next);
        leaves.on('error', (e) => res.destroy(e));
      });
      up.on('error', () => tryCopy(k + 1));
    };
    tryCopy(0);
  };
  next();
}

function sniffType(head) {
  if (head.subarray(0, 4).toString('latin1') === 'PAR1') return 'application/vnd.apache.parquet';
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'application/zstd';
  const t = head.subarray(0, 64).toString('utf8').trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'application/json';
  return 'application/octet-stream';
}

// Any other CID pinned through Filecoin Onchain Cloud: find its providers in IPNI, stream the provider's
// trustless CAR through the decoder. Size and type come from one full pass on first request and are cached.
function ipniLookup(cid, cb) {
  https.get(`https://cid.contact/cid/${cid}`, { headers: { accept: 'application/json', 'user-agent': 'chainvault-site/0.1' } }, (r) => {
    let body = ''; r.on('data', (d) => { body += d; }); r.on('end', () => {
      try {
        const results = (JSON.parse(body).MultihashResults || [])[0]?.ProviderResults || [];
        const urls = [];
        for (const p of results) for (const a of (p.Provider?.Addrs || [])) {
          const m = /^\/dns4?6?\/([^/]+)\/tcp\/(\d+)\/(https|http)$/.exec(a);
          if (m) urls.push(`${m[3]}://${m[1]}${(m[3] === 'https' && m[2] === '443') || (m[3] === 'http' && m[2] === '80') ? '' : ':' + m[2]}`);
        }
        cb(null, [...new Set(urls)]);
      } catch (e) { cb(e); }
    });
  }).on('error', cb);
}
function probeCar(url, cb) {
  https.get(url, { headers: { 'user-agent': 'chainvault-site/0.1', accept: 'application/vnd.ipld.car, */*' } }, (r) => {
    if (r.statusCode !== 200) { r.resume(); return cb(new Error(`HTTP ${r.statusCode}`)); }
    let size = 0, head = Buffer.alloc(0);
    const leaves = r.pipe(new CarLeaves());
    leaves.on('data', (d) => { size += d.length; if (head.length < 64) head = Buffer.concat([head, d]).subarray(0, 64); });
    leaves.on('end', () => cb(null, { size, type: sniffType(head) }));
    leaves.on('error', cb);
  }).on('error', cb);
}
function serveIpni(req, res, cid, wantProvider) {
  const cache = readJson(IPFS_CACHE, {});
  const go = (entry) => {
    const part = { index: 0, size: entry.size, copies: entry.sources.map((u, i) => ({ provider_id: -1 - i, url: u })) };
    return streamParts(req, res, [part], cid, { 'content-type': entry.type }, (p) => p.copies.map((c) => ({ provider_id: c.provider_id, url: `${c.url}/ipfs/${cid}` })), wantProvider);
  };
  if (cache[cid]) return go(cache[cid]);
  ipniLookup(cid, (err, urls) => {
    if (err || !urls.length) { res.writeHead(404, { 'content-type': 'text/plain', ...CORS }); return res.end('no Filecoin provider found for this CID in IPNI\n'); }
    const tryProbe = (k) => {
      if (k >= urls.length) { res.writeHead(502, { 'content-type': 'text/plain', ...CORS }); return res.end('providers found but none served the CID\n'); }
      probeCar(`${urls[k]}/ipfs/${cid}`, (e, info) => {
        if (e) return tryProbe(k + 1);
        const entry = { size: info.size, type: info.type, sources: [urls[k], ...urls.filter((u) => u !== urls[k])], probed_at: new Date().toISOString() };
        const c = readJson(IPFS_CACHE, {}); c[cid] = entry;
        try { fs.writeFileSync(IPFS_CACHE, JSON.stringify(c, null, 2)); } catch {}
        go(entry);
      });
    };
    tryProbe(0);
  });
}

function serveParam(req, res, cid, wantProvider) {
  const st = readJson(PARAMS_STATE, { files: {} });
  const f = Object.values(st.files || {}).find((x) => x.cid === cid && x.status === 'done');
  if (!f) return serveIpni(req, res, cid, wantProvider);
  return streamParts(req, res, f.parts, f.name, { 'x-proof-param-digest': f.digest }, undefined, wantProvider);
}

function serveSnapshot(req, res, which) {
  const st = readJson(path.join(DATA, 'state.json'), { snapshots: [] });
  const done = (st.snapshots || []).filter((s) => s.status === 'done' && s.manifest).sort((a, b) => b.height - a.height);
  const s = which === 'latest' ? done[0] : done.find((x) => String(x.height) === which);
  if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no such archived snapshot\n'); }
  return streamParts(req, res, s.parts, s.name, { 'x-snapshot-height': String(s.height), 'x-snapshot-sha256': s.sha256, 'x-manifest-cid': s.manifest.root_cid });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/state') return sendJson(res, 200, readJson(path.join(DATA, 'state.json'), { snapshots: [] }));
  if (url.pathname === '/api/proofs') return sendJson(res, 200, readJson(path.join(DATA, 'proofs.json'), { data_sets: {} }));
  if (url.pathname === '/api/providers') return sendJson(res, 200, { ...readJson(path.join(DATA, 'providers.json'), { providers: [] }), preferred: REHYDRATE_PROVIDER ? parseInt(REHYDRATE_PROVIDER, 10) : null });
  if (url.pathname === '/api/manifest') {
    if (url.searchParams.get('latest')) {
      const st = readJson(path.join(DATA, 'state.json'), { snapshots: [] });
      const done = (st.snapshots || []).filter((s) => s.status === 'done' && s.manifest).sort((a, b) => b.height - a.height);
      if (!done.length) return sendJson(res, 404, { error: 'no archived snapshot yet' });
      return sendJson(res, 200, readJson(path.join(DATA, 'manifests', `${done[0].name}.manifest.json`), { error: 'manifest missing' }));
    }
    const name = url.searchParams.get('name') || '';
    if (!/^[A-Za-z0-9_.\-]+$/.test(name)) return sendJson(res, 400, { error: 'bad name' });
    return sendJson(res, 200, readJson(path.join(DATA, 'manifests', `${name}.manifest.json`), { error: 'not found' }));
  }
  if (url.pathname === '/api/params') {
    const st = readJson(PARAMS_STATE, { files: {} });
    const files = Object.values(st.files || {}).map((f) => ({ ...f, manifest: f.manifest ? { root_cid: f.manifest.root_cid, piece_cid: f.manifest.piece_cid, copies: f.manifest.copies } : null }));
    return sendJson(res, 200, { updated_at: st.updated_at, manifest_url: st.manifest_url, mirror: st.mirror, manifest_entries: st.manifest_entries, files });
  }
  if (url.pathname === '/api/params-manifest') {
    const cid = url.searchParams.get('cid') || '';
    if (!/^[A-Za-z0-9]+$/.test(cid)) return sendJson(res, 400, { error: 'bad cid' });
    return sendJson(res, 200, readJson(path.join(DATA, 'params_manifests', `${cid}.manifest.json`), { error: 'not found' }));
  }
  if ((url.pathname.startsWith('/ipfs/') || url.pathname.startsWith('/snapshot/')) && req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname.startsWith('/ipfs/')) { const cid = url.pathname.slice(6).split('/')[0]; if (!/^[A-Za-z0-9]{10,}$/.test(cid)) { res.writeHead(400); return res.end('bad cid'); } return serveParam(req, res, cid, (url.searchParams.get('provider') || '').replace(/[^A-Za-z0-9.\-]/g, '') || null); }
  if (url.pathname.startsWith('/snapshot/')) return serveSnapshot(req, res, url.pathname.slice(10).split('/')[0]);
  if (url.pathname === '/api/rehydrate/start' && req.method === 'POST') return startRehydrate(req, res);
  if (url.pathname === '/api/rehydrate/stream') return streamLog(req, res);
  if (url.pathname === '/api/rehydrate/status') return sendJson(res, 200, { running: !!runningPid(), pid: runningPid() });
  let file = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  file = path.join(PUBLIC, file);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`chainvault demo on :${PORT}, data ${DATA}`));
