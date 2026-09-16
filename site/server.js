// ChainVault demo server: static site + JSON state + rehydration log stream. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3860', 10);
const DATA = process.env.CV_DATA || path.join(process.env.HOME, 'chainvault');
const PUBLIC = path.join(__dirname, 'public');
const REHYDRATE = process.env.CV_REHYDRATE || path.join(__dirname, '..', 'archiver', 'rehydrate.py');
const REHYDRATE_TOKEN = process.env.CV_REHYDRATE_TOKEN || '';
const REHYDRATE_PROVIDER = process.env.CV_REHYDRATE_PROVIDER || '';
const REHYDRATE_LOG = path.join(DATA, 'rehydrate.log');

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
  if (url.pathname === '/api/rehydrate/start' && req.method === 'POST') return startRehydrate(req, res);
  if (url.pathname === '/api/rehydrate/stream') return streamLog(req, res);
  if (url.pathname === '/api/rehydrate/status') return sendJson(res, 200, { running: !!runningPid(), pid: runningPid() });
  let file = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  file = path.join(PUBLIC, file);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`chainvault demo on :${PORT}, data ${DATA}`));
