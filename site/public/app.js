const $ = (id) => document.getElementById(id);
const fmtBytes = (b) => { if (!b) return '0 B'; const u = ['B','KB','MB','GB','TB']; let i = 0; while (b >= 1000 && i < u.length-1) { b /= 1000; i++; } return `${b.toFixed(i ? 2 : 0)} ${u[i]}`; };
const fmtDur = (s) => { if (s == null) return '–'; if (s < 0) return `overdue ${fmtDur(-s)}`; if (s < 90) return `${Math.round(s)}s`; if (s < 5400) return `${Math.round(s/60)} min`; if (s < 172800) return `${(s/3600).toFixed(1)} h`; return `${(s/86400).toFixed(1)} d`; };
const short = (c) => c ? `${c.slice(0, 10)}…${c.slice(-6)}` : '–';
const ago = (iso) => iso ? fmtDur((Date.now() - new Date(iso).getTime())/1000) + ' ago' : '–';

let providers = {}, proofs = null, state = null, preferred = null, showAll = false;
const DEFAULT_VISIBLE = 6;

async function load() {
  const [s, p, pr] = await Promise.all([
    fetch('/api/state').then(r => r.json()), fetch('/api/proofs').then(r => r.json()), fetch('/api/providers').then(r => r.json())]);
  state = s; proofs = p; providers = Object.fromEntries((pr.providers || []).map(x => [x.id, x])); preferred = pr.preferred;
  render();
}

function providerCell(c) {
  const p = providers[c.provider_id] || {};
  return `<span title="${p.location || ''}">${p.name || 'provider ' + c.provider_id}</span> <span class="muted">#${c.provider_id} · set ${c.data_set_id ?? '?'} · piece ${c.piece_id ?? '?'}</span>`;
}

function render() {
  const snaps = [...(state.snapshots || [])].sort((a, b) => b.height - a.height);
  const done = snaps.filter(s => s.status === 'done');
  const t = (proofs && proofs.totals) || {};
  $('chain').textContent = state.chain ? `· ${state.chain}` : '';
  $('c-snaps').textContent = done.length;
  $('c-bytes').textContent = fmtBytes(t.bytes_under_proof || done.reduce((a, s) => a + s.size, 0));
  $('c-proofs').textContent = t.proofs_observed ?? '–';
  $('c-last').textContent = t.latest_proof_seconds_ago != null ? fmtDur(t.latest_proof_seconds_ago) + ' ago' : '–';
  $('c-sets').textContent = t.live != null ? `${t.live} / ${t.data_sets}` : '–';
  $('c-height').textContent = done.length ? done[0].height.toLocaleString() : '–';
  $('verifier').textContent = proofs?.pdp_verifier || '';
  $('refreshed').textContent = ago(state.updated_at);
  const headAge = proofs?.head_time ? (Date.now() - new Date(proofs.head_time).getTime())/1000 : Infinity;
  $('livepill').className = 'pill' + (headAge < 900 ? ' ok' : '');
  $('livetext').textContent = proofs?.head_epoch ? `calibnet epoch ${proofs.head_epoch.toLocaleString()} · ${ago(proofs.head_time)}` : 'no proof data yet';

  const visible = showAll ? snaps : snaps.slice(0, DEFAULT_VISIBLE);
  $('showall').hidden = snaps.length <= DEFAULT_VISIBLE;
  $('showall').textContent = showAll ? `show newest ${DEFAULT_VISIBLE}` : `show all ${snaps.length}`;
  $('snapshots').innerHTML = visible.length ? visible.map(s => {
    const parts = s.parts || [];
    const m = s.manifest;
    const gw = m ? `https://inbrowser.link/ipfs/${m.root_cid}` : null;
    if (s.status === 'pruned') {
      return `<div class="snap compact"><div class="h">height ${s.height.toLocaleString()}</div><span class="tag pruned">payload pruned</span>
        <span class="muted">${s.date} · ${fmtBytes(s.size)} · manifest kept</span>${m ? ` <code class="cid">${short(m.root_cid)}</code> <a href="${gw}">gateway</a> · <a href="/api/manifest?name=${encodeURIComponent(s.name)}">json</a>` : ''}</div>`;
    }
    const uploaded = parts.filter(p => p.piece_cid).length;
    return `<div class="snap">
      <div class="head"><div class="h">height ${s.height.toLocaleString()}<small>${s.date}</small><span class="tag ${s.status}">${s.status}</span></div>
        <div class="muted small">${fmtBytes(s.size)} · ${parts.length} parts · ${uploaded}/${parts.length} on Filecoin${s.completed_at ? ' · archived ' + ago(s.completed_at) : ''}</div></div>
      <div class="kv">
        <div class="k">source</div><div><a href="${s.source_url}">${s.name}</a></div>
        <div class="k">sha256</div><div><code class="cid">${s.sha256 || '–'}</code>${s.verified_at ? ' <span class="ok small">✓ verified against publisher</span>' : ''}</div>
        <div class="k">manifest</div><div>${m ? `<code class="cid">${m.root_cid}</code> <a href="${gw}">gateway</a> · <a href="/api/manifest?name=${encodeURIComponent(s.name)}">json</a>` : '–'}</div>
        ${s.error ? `<div class="k">error</div><div class="bad">${s.error}</div>` : ''}
      </div>
      ${parts.length ? `<details><summary>${parts.length} parts, ${new Set(parts.flatMap(p => (p.copies||[]).map(c => c.provider_id))).size} providers</summary>
        <table><tr><th>#</th><th>size</th><th>piece CID</th><th>copies</th></tr>
        ${parts.map(p => `<tr><td>${p.index}</td><td>${fmtBytes(p.size)}</td><td><code class="cid">${p.piece_cid || '<span class="warn">pending</span>'}</code></td>
          <td>${(p.copies||[]).map(c => { const pr = providers[c.provider_id]; return `<div>${providerCell(c)}${pr && p.piece_cid ? ` · <a href="${pr.service_url}/piece/${p.piece_cid}">retrieve</a>` : ''}</div>`; }).join('') || '–'}</td></tr>`).join('')}
        </table></details>` : ''}
    </div>`; }).join('') : '<div class="muted">No snapshots archived yet.</div>';

  const ds = Object.entries(proofs?.data_sets || {});
  $('proofs').innerHTML = ds.length ? ds.map(([id, d]) => {
    if (d.error) return `<div class="ds"><div class="t"><b>data set ${id}</b><span class="bad small">${d.error}</span></div></div>`;
    const pr = providers[d.provider_id] || {};
    const period = (d.next_challenge_epoch - d.last_proven_epoch) || 1;
    const pct = Math.max(0, Math.min(100, 100 * (proofs.head_epoch - d.last_proven_epoch) / period));
    return `<div class="ds"><div class="t"><b>${pr.name || 'provider ' + d.provider_id} <span class="muted">· data set ${id}</span></b><span class="${d.live ? 'ok' : 'bad'}">${d.live ? '● live' : '○ not live'}</span></div>
      <div class="small">last proof <b>${fmtDur(d.last_proven_seconds_ago)} ago</b> (epoch ${d.last_proven_epoch.toLocaleString()}) · next challenge <b>${fmtDur(d.next_challenge_in_seconds)}</b> (epoch ${d.next_challenge_epoch.toLocaleString()})</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="muted small">${d.pieces} pieces · ${fmtBytes(d.bytes)} · ${d.leaf_count.toLocaleString()} leaves · ${d.proofs_observed} proofs observed since tracking began</div></div>`; }).join('')
    : '<div class="muted">No data sets yet.</div>';

  const chain = done.sort((a, b) => b.height - a.height);
  $('chain-view').innerHTML = chain.length ? `<div class="chainlist">${chain.map((s, i) => `<div class="link"><b>height ${s.height.toLocaleString()}</b><br><code class="cid">${s.manifest.root_cid}</code><br><span class="muted">parent: ${s.manifest.parent_manifest_cid ? short(s.manifest.parent_manifest_cid) : 'genesis of this archive'}</span></div>${i < chain.length - 1 ? '<div class="arrow">↓ parent_manifest_cid</div>' : ''}`).join('')}</div>` : '<div class="muted small">Nothing yet.</div>';

  const latest = chain[0];
  const anyProv = latest && (providers[preferred] || Object.values(providers)[0]);
  $('oneliner').textContent = latest && anyProv
    ? `curl -sO ${location.origin}/rehydrate.py\npython3 rehydrate.py --manifest-url ${location.origin}/api/manifest?name=${latest.name} --provider-url ${anyProv.service_url} --provider-id ${anyProv.id} --out ./${latest.name}\n# then: forest --chain calibnet --import-snapshot ./${latest.name}`
    : 'available once the first snapshot is archived';
}

let logLines = [];
function clearedMarker() { try { return JSON.parse(localStorage.getItem('cv_cleared') || 'null'); } catch { return null; } }
const esc = (s) => s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
function logClass(line) {
  if (/MISMATCH|Traceback|RuntimeError|Error|ERROR|failed|exited [1-9]/.test(line)) return 'l-bad';
  if (/WARN/.test(line)) return 'l-warn';
  if (/SNAPSHOT VERIFIED|Imported snapshot in|sha256 OK|forest exited 0/.test(line)) return 'l-ok';
  if (/^\[[\d:]+\] \$ |^\s+\$ /.test(line)) return 'l-cmd';
  if (/forest::|f3\/sidecar|libp2p/.test(line)) return 'l-forest';
  if (/GET https|fetching|assembling|verifying|manifest:/.test(line)) return 'l-step';
  return '';
}
function colourLine(line) {
  const m = line.match(/^(\[[\d:]+\])(.*)$/s);
  const body = m ? m[2] : line;
  const stamp = m ? `<span class="l-ts">${esc(m[1])}</span>` : '';
  return `<span class="${logClass(line)}">${stamp}${esc(body)}</span>`;
}
function renderLog() {
  const c = clearedMarker();
  const skip = c && logLines[0] === c.runId ? c.count : 0;
  const log = $('log');
  log.innerHTML = logLines.slice(skip).map(colourLine).join('\n') + (logLines.length > skip ? '\n' : '');
  log.scrollTop = log.scrollHeight;
}

function stream() {
  const es = new EventSource('/api/rehydrate/stream');
  es.onopen = () => { logLines = []; renderLog(); $('runstatus').textContent = ''; };
  es.onmessage = (e) => { logLines.push(JSON.parse(e.data)); renderLog(); };
  es.addEventListener('reset', () => { logLines = []; try { localStorage.removeItem('cv_cleared'); } catch {} renderLog(); });
  es.onerror = () => { $('runstatus').textContent = 'stream disconnected, retrying'; };
}

$('run').onclick = async () => {
  $('run').disabled = true; $('runstatus').textContent = 'starting…';
  const r = await fetch('/api/rehydrate/start', { method: 'POST', headers: { authorization: `Bearer ${$('token').value}` } });
  const j = await r.json();
  $('runstatus').textContent = r.ok ? 'running' : (j.error || 'failed');
  try { localStorage.removeItem('cv_cleared'); } catch {}
  logLines = []; renderLog(); setTimeout(() => { $('run').disabled = false; }, 3000);
};
$('showall').onclick = () => { showAll = !showAll; render(); };
$('clear').onclick = () => {
  try { localStorage.setItem('cv_cleared', JSON.stringify({ runId: logLines[0] || '', count: logLines.length })); } catch {}
  renderLog(); $('runstatus').textContent = '';
};

load().catch(e => { $('livetext').textContent = 'load failed: ' + e.message; });
setInterval(() => load().catch(() => {}), 30000);
stream();
