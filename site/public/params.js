const $ = (id) => document.getElementById(id);
const fmtBytes = (b) => { if (!b) return '0 B'; const u = ['B','KB','MB','GB','TB']; let i = 0; while (b >= 1000 && i < u.length-1) { b /= 1000; i++; } return `${b.toFixed(i === 0 ? 0 : b >= 100 ? 1 : 2)} ${u[i]}`; };
const fmtDur = (s) => { if (s == null) return '–'; if (s < 90) return `${Math.round(s)}s`; if (s < 5400) return `${Math.round(s/60)} min`; if (s < 172800) return `${(s/3600).toFixed(1)} h`; return `${(s/86400).toFixed(1)} d`; };
const ago = (iso) => iso ? fmtDur((Date.now() - new Date(iso).getTime())/1000) + ' ago' : '–';
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const SECTORS = [2048, 8388608, 536870912, 34359738368, 68719476736];
const sectorLabel = (b) => b >= 1 << 30 ? `${b / (1 << 30)} GiB` : b >= 1 << 20 ? `${b / (1 << 20)} MiB` : `${b / 1024} KiB`;
const FAMILIES = [
  ['proof-of-spacetime-fallback', 'PoSt', 'Window and Winning PoSt'],
  ['stacked-proof-of-replication', 'PoRep', 'sector sealing (SDR)'],
  ['empty-sector-update', 'SnapDeals', 'empty sector update'],
  ['empty-sector-update-poseidon', 'SnapDeals · Poseidon', 'empty sector update, Poseidon tree'],
];
function familyOf(name) {
  const n = name.replace(/^v28-/, '');
  for (const [key] of [...FAMILIES].sort((a, b) => b[0].length - a[0].length)) if (n.startsWith(key + '-merkletree')) return key;
  return 'other';
}
const shortName = (n) => n.replace(/^v28-/, '').replace(/-[0-9a-f]{64}(\.params|\.vk)$/, '$1');
let showList = false, filesCache = [], providersCache = {};

function spLink(f) {
  // a done file links to where it actually lives: the provider's piece for a single-piece file,
  // the manifest (which lists every piece's provider URL) for a multi-piece one
  const parts = f.parts || [];
  if (parts.length === 1 && parts[0].piece_cid) {
    const c = (parts[0].copies || [])[0]; const pr = c && providersCache[c.provider_id];
    if (pr) return `${pr.service_url.replace(/\/$/, '')}/piece/${parts[0].piece_cid}`;
  }
  return `/api/params-manifest?cid=${f.cid}`;
}
function chip(f) {
  const kind = f.name.endsWith('.vk') ? 'vk' : f.name.endsWith('.srs') ? 'srs' : 'params';
  const st = f.status || 'pending';
  const parts = f.parts || [];
  const title = `${f.name}\n${f.cid}\n${fmtBytes(f.size)} · ${st}${parts.length ? ` · ${parts.filter(p => p.piece_cid).length}/${parts.length} piece${parts.length === 1 ? '' : 's'}` : ''}${st === 'done' ? (parts.length === 1 ? '\nopens the piece on the storage provider' : '\nopens the manifest listing every piece on the storage provider') : ''}${f.error ? '\n' + f.error : ''}`;
  const inner = `<b>.${kind}</b><span>${fmtBytes(f.size)}</span>`;
  return st === 'done' ? `<a class="chip done" href="${esc(spLink(f))}" title="${esc(title)}">${inner}</a>` : `<span class="chip ${esc(st)}" title="${esc(title)}">${inner}</span>`;
}

function render(pr, proofs, prov) {
  providersCache = Object.fromEntries((prov.providers || []).map(x => [x.id, x]));
  const files = filesCache = pr.files || [];
  const done = files.filter(f => f.status === 'done');
  const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
  const doneBytes = done.reduce((a, f) => a + (f.size || 0), 0);
  const pieces = done.reduce((a, f) => a + (f.parts || []).length + (f.manifest ? 1 : 0), 0);
  const copies = done.length ? done.reduce((a, f) => a + ((f.parts || [])[0]?.copies?.length || 1), 0) / done.length : 1;
  const total = pr.manifest_entries || files.length;
  $('c-files').textContent = `${done.length} / ${total}`;
  $('c-bytes').textContent = `${fmtBytes(doneBytes)} / ${fmtBytes(totalBytes)}`;
  $('c-pieces').textContent = pieces;
  const running = files.filter(f => ['downloading', 'splitting', 'uploading'].includes(f.status));
  const price = proofs?.pricing?.price_per_tib_month_usdfc;
  $('c-cost').textContent = price && totalBytes ? ((totalBytes * copies / 1099511627776) * price).toFixed(3) : '–';
  $('c-cost').title = price ? `${price} USDFC per TiB per month on-chain, ${copies.toFixed(0)} cop${copies > 1 ? 'ies' : 'y'}, whole ${fmtBytes(totalBytes)} set` : '';
  const pct = totalBytes ? 100 * doneBytes / totalBytes : 0;
  $('progress-bar').style.width = `${pct.toFixed(1)}%`;
  $('progress-pct').textContent = `${pct.toFixed(1)}%`;
  $('progress-label').textContent = `${done.length} of ${total} files, ${fmtBytes(doneBytes)} of ${fmtBytes(totalBytes)} archived${running.length ? ` · now: ${shortName(running[0].name)} (${running[0].status})` : ''}`;
  $('verifier').textContent = proofs?.pdp_verifier || '';
  $('refreshed').textContent = ago(pr.updated_at);
  const headAge = proofs?.head_time ? (Date.now() - new Date(proofs.head_time).getTime())/1000 : Infinity;
  $('livepill').className = 'pill' + (headAge < 900 ? ' ok' : '');
  $('livetext').textContent = proofs?.head_epoch ? `calibnet epoch ${proofs.head_epoch.toLocaleString()} · ${ago(proofs.head_time)}` : 'no proof data yet';

  const cmd = `IPFS_GATEWAY=${location.origin}/ipfs/ lotus daemon`;
  $('usebox').innerHTML = `<button class="copy">copy</button><span class="prompt">$</span><span class="kw">IPFS_GATEWAY</span>=<span class="url">${location.origin}/ipfs/</span> <span class="kw">lotus</span> daemon<span class="cm"># Forest reads the same variable (it fetches only the .vk files)</span><span class="prompt">$</span><span class="kw">IPFS_GATEWAY</span>=<span class="url">${location.origin}/ipfs/</span> <span class="kw">forest</span> <span class="flag">--chain</span> calibnet`;
  const btn = $('usebox').querySelector('.copy');
  btn.onclick = async () => { try { await navigator.clipboard.writeText(cmd + '\n'); btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1500); } catch { btn.textContent = 'select & copy'; } };

  const byCell = {};
  for (const f of files) { const k = `${familyOf(f.name)}|${f.sector_size}`; (byCell[k] = byCell[k] || []).push(f); }
  const fams = [...FAMILIES];
  const others = files.filter(f => familyOf(f.name) === 'other');  // e.g. the inner-product SRS: one file, no sector size
  const sectors = SECTORS.filter(s => files.some(f => f.sector_size === s));
  $('matrix').innerHTML = `<tr><th class="fam">proof family</th>${sectors.map(s => `<th class="sec">${sectorLabel(s)} sectors</th>`).join('')}</tr>` +
    fams.map(([key, label, sub]) => `<tr><td class="fam">${esc(label)}<small>${esc(sub || key)}</small></td>${sectors.map(s => {
      const cell = (byCell[`${key}|${s}`] || []).sort((a, b) => (a.name.endsWith('.vk') ? 1 : 0) - (b.name.endsWith('.vk') ? 1 : 0));
      return cell.length ? `<td class="cell">${cell.map(chip).join('<br>')}</td>` : `<td class="empty">–</td>`;
    }).join('')}</tr>`).join('') +
    (others.length ? `<tr><td class="fam">Aggregation SRS<small>inner-product SRS for aggregated proofs, all sector sizes</small></td><td class="cell" colspan="${sectors.length}">${others.map(chip).join(' ')}</td></tr>` : '');

  renderList();
}

function renderList() {
  $('togglelist').textContent = showList ? 'hide' : 'show';
  $('filelist').hidden = !showList;
  if (!showList) return;
  const rows = [...filesCache].sort((a, b) => (b.size || 0) - (a.size || 0));
  $('filelist').innerHTML = `<div class="filelist"><table><tr><th>file</th><th>sector</th><th>size</th><th>status</th><th>pieces</th><th>provider</th><th></th></tr>${rows.map(f => {
    const pv = (f.parts || [])[0]?.copies?.map(c => providersCache[c.provider_id]?.name || `provider ${c.provider_id}`).join(', ') || '–';
    const links = f.status === 'done' ? `<a href="${esc(spLink(f))}">on the provider</a> · <a href="/api/params-manifest?cid=${esc(f.cid)}">manifest</a> · <a href="/ipfs/${esc(f.cid)}">via vault</a>` : (f.error ? `<span class="bad">${esc(f.error).slice(0, 70)}</span>` : '');
    return `<tr><td class="mono name" title="${esc(f.name)}&#10;${esc(f.cid)}">${esc(shortName(f.name))}</td><td>${f.sector_size ? sectorLabel(f.sector_size) : 'all'}</td><td>${fmtBytes(f.size)}</td><td><span class="chip ${esc(f.status || 'pending')}">${esc(f.status || 'pending')}</span></td><td>${(f.parts || []).length || '–'}</td><td>${esc(pv)}</td><td>${links}</td></tr>`;
  }).join('')}</table></div>`;
}

async function load() {
  const [pr, proofs, prov] = await Promise.all([fetch('/api/params').then(r => r.json()), fetch('/api/proofs').then(r => r.json()), fetch('/api/providers').then(r => r.json())]);
  render(pr, proofs, prov);
}
$('togglelist').onclick = () => { showList = !showList; renderList(); };
load().catch(e => { $('livetext').textContent = 'load failed: ' + e.message; });
setInterval(() => load().catch(() => {}), 30000);
