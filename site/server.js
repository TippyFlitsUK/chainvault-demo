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

// GET /ipfs/<original cid>: stream a proof-parameter file back out of its pieces on the SP.
// A node sets IPFS_GATEWAY to this path and verifies the manifest digest itself, so this is byte-exact or nothing.
function serveParam(req, res, cid) {
  const st = readJson(PARAMS_STATE, { files: {} });
  const f = Object.values(st.files || {}).find((x) => x.cid === cid && x.status === 'done');
  if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not archived\n'); }
  const parts = [...f.parts].sort((a, b) => a.index - b.index);
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
    'x-proof-param-digest': f.digest, 'content-disposition': `inline; filename="${f.name}"`, 'cache-control': 'no-cache',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const preferred = REHYDRATE_PROVIDER ? parseInt(REHYDRATE_PROVIDER, 10) : null;
  let offset = 0, i = 0, closed = false;
  req.on('close', () => { closed = true; });
  const next = () => {
    if (closed) return;
    if (i >= parts.length || offset > end) return res.end();
    const part = parts[i++];
    const pStart = offset, pEnd = offset + part.size - 1; offset += part.size;
    if (pEnd < start) return next();
    const copies = [...(part.copies || [])].sort((a, b) => (a.provider_id === preferred ? -1 : 0) - (b.provider_id === preferred ? -1 : 0));
    const tryCopy = (k) => {
      if (k >= copies.length) { res.destroy(new Error(`no provider served part ${part.index}`)); return; }
      const base = providerUrl(copies[k].provider_id);
      if (!base) return tryCopy(k + 1);
      const up = https.get(`${base}/piece/${part.piece_cid}`, { headers: { 'user-agent': 'chainvault-site/0.1' } }, (r) => {
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
    const name = url.searchParams.get('name') || '';
    if (!/^[A-Za-z0-9_.\-]+$/.test(name)) return sendJson(res, 400, { error: 'bad name' });
    return sendJson(res, 200, readJson(path.join(DATA, 'params_manifests', `${name}.manifest.json`), { error: 'not found' }));
  }
  if (url.pathname.startsWith('/ipfs/')) return serveParam(req, res, url.pathname.slice(6).split('/')[0]);
  if (url.pathname === '/api/rehydrate/start' && req.method === 'POST') return startRehydrate(req, res);
  if (url.pathname === '/api/rehydrate/stream') return streamLog(req, res);
  if (url.pathname === '/api/rehydrate/status') return sendJson(res, 200, { running: !!runningPid(), pid: runningPid() });
  let file = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  file = path.join(PUBLIC, file);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`chainvault demo on :${PORT}, data ${DATA}`));
