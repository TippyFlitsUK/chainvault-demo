const $ = (id) => document.getElementById(id);
const fmtBytes = (b) => { if (!b) return '0 B'; const u = ['B','KB','MB','GB','TB']; let i = 0; while (b >= 1000 && i < u.length-1) { b /= 1000; i++; } return `${b.toFixed(i === 0 ? 0 : b >= 100 ? 1 : 2)} ${u[i]}`; };
const fmtDur = (s) => { if (s == null) return '–'; if (s < 90) return `${Math.round(s)}s`; if (s < 5400) return `${Math.round(s/60)} min`; if (s < 172800) return `${(s/3600).toFixed(1)} h`; return `${(s/86400).toFixed(1)} d`; };
const ago = (iso) => iso ? fmtDur((Date.now() - new Date(iso).getTime())/1000) + ' ago' : '–';
const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
const sector = (b) => b >= 1 << 30 ? `${b / (1 << 30)} GiB` : b >= 1 << 20 ? `${b / (1 << 20)} MiB` : b ? `${b / 1024} KiB` : '–';
const shortName = (n) => n.replace(/^v28-/, '').replace(/-[0-9a-f]{64}(\.params|\.vk)$/, '$1');

async function load() {
  const [pr, proofs, prov] = await Promise.all([fetch('/api/params').then(r => r.json()), fetch('/api/proofs').then(r => r.json()), fetch('/api/providers').then(r => r.json())]);
  const providers = Object.fromEntries((prov.providers || []).map(x => [x.id, x]));
  const files = (pr.files || []).sort((a, b) => (a.status === 'done') - (b.status === 'done') || (b.size || 0) - (a.size || 0));
  const done = files.filter(f => f.status === 'done');
  const bytes = done.reduce((a, f) => a + (f.size || 0), 0);
  const pieces = done.reduce((a, f) => a + (f.parts || []).length + (f.manifest ? 1 : 0), 0);
  const copies = done.length ? done.reduce((a, f) => a + ((f.parts || [])[0]?.copies?.length || 1), 0) / done.length : 1;
  $('c-files').textContent = `${done.length} / ${pr.manifest_entries || files.length || '–'}`;
  $('c-bytes').textContent = fmtBytes(bytes);
  $('c-pieces').textContent = pieces;
  const running = files.filter(f => ['downloading', 'splitting', 'uploading'].includes(f.status));
  $('c-inprogress').textContent = running.length ? shortName(running[0].name).slice(0, 22) + '…' : 'idle';
  $('c-inprogress').title = running.map(f => `${f.name}: ${f.status}`).join('\n');
  const price = proofs?.pricing?.price_per_tib_month_usdfc;
  $('c-cost').textContent = price && bytes ? ((bytes * copies / 1099511627776) * price).toFixed(3) : '–';
  $('subtitle').textContent = `${files.length} listed · ${done.length} archived`;
  $('verifier').textContent = proofs?.pdp_verifier || '';
  $('refreshed').textContent = ago(pr.updated_at);
  const headAge = proofs?.head_time ? (Date.now() - new Date(proofs.head_time).getTime())/1000 : Infinity;
  $('livepill').className = 'pill' + (headAge < 900 ? ' ok' : '');
  $('livetext').textContent = proofs?.head_epoch ? `calibnet epoch ${proofs.head_epoch.toLocaleString()} · ${ago(proofs.head_time)}` : 'no proof data yet';

  const cmd = `IPFS_GATEWAY=${location.origin}/ipfs/ lotus daemon`;
  const cmd2 = `curl -sO ${location.origin}/ipfs/<cid>`;
  $('usebox').innerHTML = `<button class="copy">copy</button><span class="prompt">$</span><span class="kw">IPFS_GATEWAY</span>=<span class="url">${location.origin}/ipfs/</span> <span class="kw">lotus</span> daemon<span class="cm"># or any single file by its original CID, digest checked by you</span><span class="prompt">$</span><span class="kw">curl</span> <span class="flag">-sO</span> <span class="url">${location.origin}/ipfs/</span>&lt;cid&gt;`;
  const btn = $('usebox').querySelector('.copy');
  btn.onclick = async () => { try { await navigator.clipboard.writeText(cmd + '\n'); btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1500); } catch { btn.textContent = 'select & copy'; } };

  $('files').innerHTML = `<tr><th>file</th><th>sector</th><th>size</th><th>status</th><th>pieces</th><th>provider</th><th>original CID</th><th></th></tr>` + files.map(f => {
    const pv = (f.parts || [])[0]?.copies?.map(c => providers[c.provider_id]?.name || `provider ${c.provider_id}`).join(', ') || '–';
    const tag = `<span class="tag ${esc(f.status || 'pending')}">${esc(f.status || 'pending')}</span>${f.degraded_parts ? ` <span class="tag warn-tag">reduced redundancy</span>` : ''}`;
    const links = f.status === 'done' ? `<a href="/ipfs/${esc(f.cid)}">download via vault</a> · <a href="/api/params-manifest?name=${encodeURIComponent(f.name)}">manifest</a>` : (f.error ? `<span class="bad small">${esc(f.error).slice(0, 80)}</span>` : '');
    return `<tr><td class="name" title="${esc(f.name)}">${esc(shortName(f.name))}</td><td>${sector(f.sector_size)}</td><td>${fmtBytes(f.size)}</td><td>${tag}</td><td>${(f.parts || []).length || '–'}</td><td>${esc(pv)}</td><td><code class="cid">${esc(f.cid)}</code></td><td>${links}</td></tr>`;
  }).join('');
}
load().catch(e => { $('livetext').textContent = 'load failed: ' + e.message; });
setInterval(() => load().catch(() => {}), 30000);
