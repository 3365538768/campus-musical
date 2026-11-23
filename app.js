const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const WEEK = '日一二三四五六';
const CAT = {upcoming:'预告', show:'演出', review:'回顾', other:'动态'};
const SRC = {wx:'公众号', xhs:'小红书', bili:'B站'};
const D = {posts:[], clubs:[], videos:[], meta:{}};
const FILTERS = ['province', 'city', 'level', 'school', 'show'];
const DUR = ['5分钟内', '5–30分钟', '30–75分钟', '75分钟以上'];
const TABS = ['videos', 'big', 'clubs', 'wish', 'submit', 'posts'];
const Q = {vkind: '', vdur: '', vsort: 'hot', pcat: '', psrc: '', group: false};  // 快捷方块的状态
const PAGE = 60;
let shown = PAGE, videosLoaded = false;  // 分页：先渲染 60 条，滚到底再加载
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'videos';

const DAY = 86400;
const now = () => Date.now() / 1000;
const day = t => t ? new Date(t * 1000).toLocaleDateString('zh-CN') : '日期未知';
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dayOffset = n => isoDay(new Date(Date.now() + n * DAY * 1000));
const fmtDur = s => !s ? '' : s >= 3600 ? `${Math.floor(s/3600)}小时${Math.round(s%3600/60)}分` : `${Math.round(s/60)}分钟`;
const durBucket = s => !s ? '' : s < 300 ? DUR[0] : s < 1800 ? DUR[1] : s < 4500 ? DUR[2] : DUR[3];
const F = () => Object.fromEntries(FILTERS.map(k => [k, $(k).value]).concat([['kw', $('kw').value.trim().toLowerCase()]]));
const itemId = url => { let h = 5381; for (const c of url.split('?')[0]) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };

// ---------- 站内统计与评论（Supabase，可选） ----------
const CFG = window.CM_CFG || {};
const SB = CFG.supabaseUrl && CFG.anonKey;
const CLICKS = {}, CCOUNT = {}, CHOT = {};  // CHOT：整点快照的评论数（用于排序）
async function sb(path, opts = {}) {
  // 新版 publishable key（sb_publishable_…）只放 apikey 头；旧版 anon key（JWT）同时放 Authorization
  const auth = CFG.anonKey.startsWith('sb_') ? {} : {Authorization: 'Bearer ' + CFG.anonKey};
  const r = await fetch(CFG.supabaseUrl + '/rest/v1/' + path, {...opts, headers: {apikey: CFG.anonKey, ...auth,
    'Content-Type': 'application/json', Prefer: 'return=minimal', ...(opts.headers || {})}});
  if (!r.ok) throw new Error(r.status);
  return r.status === 204 || opts.method === 'POST' ? null : r.json();
}
function track(table, row) { if (SB) sb(table, {method: 'POST', body: JSON.stringify(row)}).catch(() => {}); }
async function loadStats() {
  if (!SB) return;
  try {
    // 热度按整点快照统计（所有人同一小时内看到的排序一致）；视图不存在时退回实时统计
    let cc;
    try { cc = await sb('click_counts_hourly?select=item,c'); } catch (e) { cc = await sb('click_counts?select=item,c'); }
    cc.forEach(r => CLICKS[r.item] = r.c);
    try { (await sb('comment_counts?select=item,c')).forEach(r => CCOUNT[r.item] = r.c); } catch (e) {}
    try { (await sb('comment_counts_hourly?select=item,c')).forEach(r => CHOT[r.item] = r.c); } catch (e) { Object.assign(CHOT, CCOUNT); }
    const hot = await sb('search_counts?select=q,c&order=c.desc&limit=12');
    if (hot.length) {
      $('hotSearch').hidden = false;
      $('hotSearch').innerHTML = '<span class="mute">🔥 大家在搜：</span>' + hot.map(r => `<a class="chip" data-kw="${esc(r.q)}">${esc(r.q)}</a>`).join('');
    }
  } catch (e) {}
  render(true);
}
const clicks = x => CLICKS[itemId(x.url)] || 0;
// 热度（每小时更新）：置顶 + 站内观看×2000 + 评论×5000 + B站播放
const hotScore = x => (x.pin ? 1e12 : 0) + clicks(x) * 2000 + (CHOT[itemId(x.url)] || 0) * 5000 + (+x.play || 0);

// ---------- 数据 ----------
function unpackVideo(v) {
  if (v.url.startsWith('BV:')) v.url = 'https://www.bilibili.com/video/' + v.url.slice(3);
  if (v.cover && v.cover.startsWith('/')) v.cover = 'https://i0.hdslb.com' + v.cover;
  v.shows = v.shows || [];
  return v;
}
const needVideos = () => ['big', 'videos'].includes(tab);
async function ensureVideos() {
  if (videosLoaded) return;
  videosLoaded = true;
  $('view').innerHTML = '<div class="empty">🎬 正在拉开帷幕…</div>';
  D.videos = ((await getData('videos')) || []).map(unpackVideo);
  render();
}
// meta 每次从本站取（判断版本）；其余优先走 CDN 的固定版本，失败再回落到本站
let VER = '';
async function getData(name) {
  const tries = [];
  if (VER && CFG.cdn) tries.push(() => fetchT(`${CFG.cdn}@${VER}/data/${name}.dat`, 5000));
  tries.push(() => fetch(`data/${name}.dat?v=${VER || Date.now()}`));
  for (const t of tries) {
    try { const r = await t(); if (r.ok) return await decodeDat(await r.arrayBuffer(), name); } catch (e) {}
  }
  return null;
}
// 数据文件是加密的（gzip + xorshift32 密钥流），这里还原
const DK = 'GqhObwjtIJD5r_TdDE7L-5Vxlqtvs3wh';
async function decodeDat(buf, name) {
  const b = new Uint8Array(buf);
  let s = 0x811c9dc5;
  for (const c of new TextEncoder().encode(DK + name)) s = Math.imul(s ^ c, 0x01000193) >>> 0;
  s = s || 1;
  for (let i = 0; i < b.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; b[i] ^= s & 255; }
  const text = await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}
function fetchT(url, ms) {
  const c = new AbortController(); setTimeout(() => c.abort(), ms);
  return fetch(url, {signal: c.signal});
}

// ---------- 过滤 ----------
function match(x, f, fields) {
  if (f.province && x.province !== f.province) return false;
  if (f.city && x.city !== f.city) return false;
  if (f.level && x.level !== f.level) return false;
  if (f.school && x.school !== f.school) return false;
  if (f.show && !(x.shows || []).includes(f.show)) return false;
  return !f.kw || fields.some(k => String(Array.isArray(x[k]) ? x[k].join(' ') : x[k] || '').toLowerCase().includes(f.kw));
}
const PF = ['title', 'club', 'school', 'city', 'digest', 'venue', 'shows', 'author'];
const VF = ['title', 'club', 'author', 'school', 'city', 'shows'];

// ---------- 卡片 ----------
const showChips = x => (x.shows || []).map(s => `<a class="chip show" data-show="${esc(s)}">《${esc(s)}》</a>`).join('');
const levelChip = x => x.level && x.level !== '大学' ? `<span class="chip lv">${esc(x.level)}</span>` : '';
const clubMeta = p => `<b>${esc(p.club)}</b>${p.school && p.school !== p.club ? ' · ' + esc(p.school) : ''}${p.city ? ' · ' + esc(p.city) : ''}`;
const unoff = x => x.unofficial ? `<span class="chip ghost">非官方 · ${esc(x.author)}</span> ` : '';
const tools = x => SB ? `<div class="cbar">${clicks(x) ? `<span class="mute">👀 ${clicks(x)}</span>` : ''}<button class="cbtn" data-comment="${esc(x.url)}">💬 评论${CCOUNT[itemId(x.url)] ? ' ' + CCOUNT[itemId(x.url)] : ''}</button></div><div class="cbox" hidden></div>` : '';
const link = (x, cls, text) => `<a class="${cls}" href="${esc(x.url)}" target="_blank" rel="noopener" data-track="${esc(x.url)}">${text}</a>`;

function postCard(p) {
  const badge = p.repo ? '<span class="badge review">Repo</span>' : `<span class="badge ${p.cat}">${CAT[p.cat] || '动态'}</span>`;
  return `<div class="card post"><div class="body">
    <div>${badge}${p.big ? '<span class="badge big">大戏</span>' : ''}${link(p, 'title', esc(p.title))}</div>
    <div class="meta">${unoff(p)}${clubMeta(p)} · ${SRC[p.src] || ''} · ${p.unofficial && !p.dated ? '发现于 ' : ''}${day(p.time)}</div>
    <div class="chips">${levelChip(p)}${showChips(p)}</div>
    ${p.digest ? `<div class="dg">${esc(p.digest)}</div>` : ''}${tools(p)}</div>
    ${p.cover ? `<img class="cover" src="${esc(p.cover)}" loading="lazy" alt="">` : ''}</div>`;
}

function vidCard(v) {
  return `<div class="card vid"><a href="${esc(v.url)}" target="_blank" rel="noopener" class="thumb" data-track="${esc(v.url)}">
    ${v.cover ? `<img src="${esc(v.cover)}@400w_250h_1c.webp" loading="lazy" alt="" onerror="this.onerror=null;this.src='${esc(v.cover)}'">` : '<div class="noimg">🎭</div>'}
    ${v.dur ? `<span class="dur">${fmtDur(v.dur)}</span>` : ''}${v.kind && v.kind !== '选段' ? `<span class="kind k-${v.kind}">${v.kind}</span>` : ''}
    ${v.hot ? `<span class="fire" title="最热第 ${v.hot}">🔥${v.hot <= 3 ? ' TOP' + v.hot : ''}</span>` : ''}<span class="play">▶</span></a>
    ${link(v, 't', esc(v.title))}
    <div class="meta">${unoff(v)}${esc(v.club || v.author)}${v.school && v.school !== v.club ? ' · ' + esc(v.school) : ''} · ${day(v.time)}</div>
    <div class="chips">${levelChip(v)}${showChips(v)}</div>${tools(v)}</div>`;
}

// ---------- 视图 ----------
const more = total => total > shown ? `<div class="more" id="more">已显示 ${shown} / ${total}，继续下滑加载更多…</div>` : '';
function setCount(n) { $('count').textContent = `共 ${n} 条`; }
function tiles(items, cur, key) {
  return items.map(([v, label, n]) => `<button class="tile${cur === v ? ' on' : ''}" data-q="${key}" data-v="${esc(v)}">${label}${n !== undefined ? `<span>${n}</span>` : ''}</button>`).join('');
}
// 剧目方块：版本越多方块越大；再点一次取消筛选
function showTiles(items, f, limit, unit) {
  const cnt = {};
  items.forEach(v => (v.shows || []).slice(0, 1).forEach(s => cnt[s] = (cnt[s] || 0) + 1));
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = top.length ? top[0][1] : 1;
  const size = n => n / max >= 0.5 && n >= 3 ? 3 : n / max >= 0.25 && n >= 2 ? 2 : n / max >= 0.1 && n >= 2 ? 1 : 0;  // 按相对多少分档
  return '<div class="showtiles">' + top.map(([s, n]) =>
    `<button class="stile s${size(n)}${f.show === s ? ' on' : ''}" data-show="${esc(s)}">${esc(s)}<span>${n} ${unit}</span></button>`).join('') + '</div>';
}

function viewVideos(f) {
  const base = D.videos.filter(v => match(v, f, VF));
  const vs = base.filter(v => (!Q.vkind || v.kind === Q.vkind) && (!Q.vdur || durBucket(v.dur) === Q.vdur))
    .sort((a, b) => Q.vsort === 'hot' ? hotScore(b) - hotScore(a) : b.time - a.time);
  const n = fn => base.filter(fn).length;
  $('quick').innerHTML = showTiles(D.videos.filter(v => match(v, {...f, show: ''}, VF)), f, 30, '个视频')
    + '<div class="tiles">' + tiles([['hot', '🔥 最热'], ['new', '🕘 最新']], Q.vsort, 'vsort') + '<span class="sep"></span>'
    + tiles([['', '全部', base.length], ['大戏', '🏆 大戏（45分钟以上）', n(v => v.kind === '大戏')], ['选段', '选段', n(v => v.kind === '选段')]], Q.vkind, 'vkind') + '<span class="sep"></span>'
    + tiles([['', '全部时长'], ...DUR.map(d => [d, d, n(v => durBucket(v.dur) === d)])], Q.vdur, 'vdur') + '</div>';
  setCount(vs.length);
  return vs.length ? '<div class="grid">' + vs.slice(0, shown).map(vidCard).join('') + '</div>' + more(vs.length) : '<div class="empty">没有符合条件的视频</div>';
}

function viewBig(f) {
  const all = D.videos.filter(v => v.kind === '大戏');
  const vs = all.filter(v => match(v, f, VF)).sort((a, b) => hotScore(b) - hotScore(a));
  $('quick').innerHTML = showTiles(all.filter(v => match(v, {...f, show: ''}, VF)), f, 200, '个版本')
    + `<label class="mute"><input type="checkbox" id="groupShow" ${Q.group ? 'checked' : ''}> 按剧目分组</label>`;
  $('groupShow').onchange = e => { Q.group = e.target.checked; render(); };
  setCount(vs.length);
  if (!vs.length) return '<div class="empty">没有符合条件的大戏</div>';
  if (!Q.group) return '<div class="grid">' + vs.slice(0, shown).map(vidCard).join('') + '</div>' + more(vs.length);
  const g = {};
  vs.forEach(v => (g[v.shows[0] || '其他'] ||= []).push(v));
  return Object.keys(g).sort((a, b) => g[b].length - g[a].length).map(s =>
    `<div class="group">《${esc(s)}》 <span class="mute">${g[s].length} 个版本</span></div><div class="grid">${g[s].map(vidCard).join('')}</div>`).join('');
}

function viewPosts(f) {
  const base = D.posts.filter(p => match(p, f, PF));
  const ps = base.filter(p => (!Q.pcat || (Q.pcat === 'Repo' ? p.repo : Q.pcat === '演出相关' ? p.cat !== 'other' && !p.repo : CAT[p.cat] === Q.pcat && !p.repo))
    && (!Q.psrc || (Q.psrc === '非官方' ? p.unofficial : SRC[p.src] === Q.psrc && !p.unofficial)));
  const n = fn => base.filter(fn).length;
  $('quick').innerHTML = '<div class="tiles">' + tiles([['', '全部', base.length], ['演出相关', '演出相关', n(p => p.cat !== 'other' && !p.repo)],
      ...['预告', '演出', '回顾', '动态'].map(c => [c, c, n(p => CAT[p.cat] === c && !p.repo)]), ['Repo', '✍️ Repo / 观后感', n(p => p.repo)]], Q.pcat, 'pcat')
    + '<span class="sep"></span>' + tiles([['', '全部来源'], ['公众号', '公众号', n(p => p.src === 'wx')], ['小红书', '小红书', n(p => p.src === 'xhs' && !p.unofficial)],
      ['非官方', '非官方', n(p => p.unofficial)]], Q.psrc, 'psrc') + '</div>';
  setCount(ps.length);
  return ps.slice(0, shown).map(postCard).join('') + more(ps.length) || '<div class="empty">没有符合条件的动态</div>';
}

function viewClubs(f) {
  const cs = D.clubs.filter(c => match(c, {...f, show: ''}, ['name', 'school', 'city', 'signature']));
  setCount(cs.length);
  $('quick').innerHTML = '';
  const by = {};
  cs.forEach(c => (by[c.province || '其他'] ||= []).push(c));
  const keys = Object.keys(by).sort((a, b) => a === '其他' ? 1 : b === '其他' ? -1 : by[b].length - by[a].length);
  const links = c => [c.wx && `<span class="chip">公众号：${esc(c.wx_name || c.name)}</span>`,
    c.bili && `<a class="chip" href="${esc(c.bili)}" target="_blank" rel="noopener">B站</a>`,
    c.xhs && `<a class="chip" href="${esc(c.xhs)}" target="_blank" rel="noopener">小红书</a>`].filter(Boolean).join('');
  return keys.map(p => `<div class="group">${esc(p)} <span class="mute">${by[p].length}</span></div><div class="cgrid">` +
    by[p].sort((a, b) => (a.level > b.level ? 1 : a.level < b.level ? -1 : 0) || a.school.localeCompare(b.school, 'zh')).map(c => `<div class="card club">
      ${c.avatar ? `<img src="${esc(c.avatar)}" loading="lazy" alt="" onerror="this.outerHTML='<div class=&quot;ava&quot;>${esc((c.school || c.name).slice(0, 1))}</div>'">`
        : `<div class="ava">${esc((c.school || c.name).slice(0, 1))}</div>`}
      <div><div class="n">${esc(c.name)}</div><div class="s">${levelChip(c)}${esc(c.school)}${c.city ? ' · ' + esc(c.city) : ''}</div>
      <div class="chips">${links(c)}</div></div></div>`).join('') + '</div>').join('')
    || '<div class="empty">没有符合条件的剧社</div>';
}

// 想排 / 想看：名录只用于搜索；列表只显示有人投过票的剧目，按两者总和排序（wishes 表 + wish_counts 视图）
let CATALOG = null, WISH = null, WPER = 'all';
const PERIODS = [['all', '🏆 总榜'], ['y', '📅 全年榜'], ['h', '🎓 学期榜'], ['q', '🌱 季度榜']];
const PERIOD_TIP = {all: '全部时间', y: '最近 12 个月', h: '最近 6 个月', q: '最近 3 个月'};
const wishName = m => m.zh ? (m.en ? `${m.zh} <span class="mute">${esc(m.en)}</span>` : m.zh) : esc(m.en);
async function loadWish() {
  if (!CATALOG) CATALOG = (await getData('musicals')) || [];
  // wish_stats 视图带各时间段的票数；还没建时退回 wish_counts（只有总榜）
  try { WISH = await sb('wish_stats?select=*&limit=1000'); }
  catch (e) {
    try { WISH = (await sb('wish_counts?select=show,name,perform,watch&limit=1000')).map(w => ({...w, p_all: w.perform, w_all: w.watch})); }
    catch (e2) { WISH = []; }
  }
  if (tab === 'wish') render(true);
}
const wp = (w, k) => +w[`${k}_${WPER}`] || 0;  // 当前榜单时间段的票数（k: p 想排 / w 想看）
function wishCard(w, rank) {
  const m = CATALOG.find(x => x.id === w.show) || {zh: w.name || w.show};
  const voted = k => localStorage.getItem(`wish:${w.show}:${k}`) ? ' on' : '';
  return `<div class="card wish">${m.img ? `<img src="${esc(m.img)}" loading="lazy" alt="" onerror="this.outerHTML='<div class=&quot;wimg&quot;>🎭</div>'">` : '<div class="wimg">🎭</div>'}
    <div class="wb"><div class="wr">#${rank}</div><div class="wn">${m.zh ? esc(m.zh) : esc(m.en)}</div>${m.zh && m.en ? `<div class="mute">${esc(m.en)}${m.year ? ' · ' + m.year : ''}</div>` : m.year ? `<div class="mute">${m.year}</div>` : ''}
    <div class="wbtns"><button class="wbtn${voted('perform')}" data-wish="${esc(w.show)}" data-kind="perform" data-name="${esc(m.zh || m.en || w.name)}">🎭 想排 <b>${wp(w, 'p')}</b></button>
    <button class="wbtn${voted('watch')}" data-wish="${esc(w.show)}" data-kind="watch" data-name="${esc(m.zh || m.en || w.name)}">👀 想看 <b>${wp(w, 'w')}</b></button></div></div></div>`;
}
function viewWish() {
  $('quick').innerHTML = ''; $('count').textContent = '';
  if (!CATALOG || !WISH) { loadWish(); return '<div class="empty">加载中…</div>'; }
  const list = WISH.filter(w => wp(w, 'p') + wp(w, 'w') > 0).sort((a, b) => wp(b, 'p') + wp(b, 'w') - wp(a, 'p') - wp(a, 'w'));
  const hasPeriods = WISH.some(w => 'p_q' in w);
  return `<div class="card wsearch"><div class="wsh">💡 你最想<b>排</b>哪部剧？最想<b>看</b>谁家的版本？</div>
      <input id="wq" placeholder="搜剧目（中英文都行），如：汉密尔顿 / Hamilton / 来自远方" autocomplete="off"><div id="wsug"></div></div>
    <div class="group">🔥 剧友心愿榜 <span class="mute">${PERIOD_TIP[WPER]} · ${list.length} 部 · 按 想排+想看 排序</span></div>
    <div class="tiles">${PERIODS.filter(([k]) => k === 'all' || hasPeriods).map(([k, label]) => `<button class="tile${WPER === k ? ' on' : ''}" data-wper="${k}">${label}</button>`).join('')}</div>
    ${list.length ? '<div class="wgrid">' + list.map((w, i) => wishCard(w, i + 1)).join('') + '</div>' : '<div class="empty">还没有人投票，搜一部剧投出第一票吧</div>'}`;
}
function wishSuggest() {
  const q = $('wq').value.trim().toLowerCase();
  if (!q) { $('wsug').innerHTML = ''; return; }
  const hits = CATALOG.filter(m => (m.zh || '').toLowerCase().includes(q) || (m.en || '').toLowerCase().includes(q))
    .sort((a, b) => (b.zh ? 1 : 0) - (a.zh ? 1 : 0) || (a.en || a.zh).length - (b.en || b.zh).length).slice(0, 8);
  const row = (id, label, name) => `<div class="sug"><span>${label}</span><button class="wbtn" data-wish="${esc(id)}" data-kind="perform" data-name="${esc(name)}">🎭 想排</button><button class="wbtn" data-wish="${esc(id)}" data-kind="watch" data-name="${esc(name)}">👀 想看</button></div>`;
  $('wsug').innerHTML = hits.map(m => row(m.id, wishName(m) + (m.year ? ` <span class="mute">${m.year}</span>` : ''), m.zh || m.en)).join('')
    + (hits.some(m => [m.zh, m.en].some(t => (t || '').toLowerCase() === q)) ? '' : row('custom:' + q.slice(0, 60), `没找到？直接投「${esc($('wq').value.trim())}」`, $('wq').value.trim()));
}
async function vote(btn) {
  const id = btn.dataset.wish, kind = btn.dataset.kind, key = `wish:${id}:${kind}`;
  if (localStorage.getItem(key)) return toast('你已经投过这一票啦');
  try {
    await sb('wishes', {method: 'POST', body: JSON.stringify({show: id, name: (btn.dataset.name || '').slice(0, 80), kind})});
    localStorage.setItem(key, '1');
    toast(kind === 'perform' ? '已记下：你想排这部剧 🎭' : '已记下：你想看这部剧 👀');
    WISH = null; $('wq') && ($('wq').value = ''); loadWish();
  } catch (e) { toast('暂未开放，请稍后再试'); }
}

// 申请收录：内容不公开（含联系方式），存在 submissions 表，访客只能提交
const LINK_OK = /^https?:\/\/([\w-]+\.)*(bilibili\.com|b23\.tv|xiaohongshu\.com|xhslink\.com)\//i;
function viewSubmit() {
  setCount(0); $('count').textContent = ''; $('quick').innerHTML = '';
  return `<div class="card subcard"><h2>📮 申请收录</h2>
    <p class="mute">发现我们漏掉的校园音乐剧？填一下，审核后会加进网站。目前只支持 <b>B站</b> 和 <b>小红书</b> 链接；联系方式只用于审核时联系你，不会公开。</p>
    <div class="cform">
      <input id="sbSchool" placeholder="学校（如：华中科技大学 / 人大附中）" maxlength="60">
      <input id="sbShow" placeholder="剧目名称（如：寻找梦幻岛）" maxlength="60">
      <input id="sbLink" placeholder="链接：B站视频或小红书笔记（https://…）" maxlength="300">
      <input id="sbContact" placeholder="联系方式（微信 / 小红书号 / 邮箱）" maxlength="100">
      <button class="btn" id="sbSend">提交申请 📮</button>
    </div></div>`;
}
async function sendSubmit() {
  const v = id => $(id).value.trim();
  const row = {school: v('sbSchool'), show: v('sbShow'), link: v('sbLink'), contact: v('sbContact')};
  if (!row.school || !row.show || !row.link || !row.contact) return toast('四项都要填哦');
  if (!LINK_OK.test(row.link)) return toast('链接目前只支持 B站 和 小红书');
  $('sbSend').disabled = true;
  try {
    await sb('submissions', {method: 'POST', body: JSON.stringify(row)});
    ['sbSchool', 'sbShow', 'sbLink', 'sbContact'].forEach(id => $(id).value = '');
    toast('收到！审核后会加进网站 🎭');
  } catch (e) { toast('暂时无法提交，请稍后再试'); }
  $('sbSend').disabled = false;
}

// 右侧一列：最近 3 个月的全部演出相关消息（预告/演出），不受筛选影响，按消息日期从新到旧
function renderSide() {
  const ps = D.posts.filter(p => !p.repo && (p.cat === 'upcoming' || p.cat === 'show') && p.time >= now() - 90 * DAY)
    .sort((a, b) => b.time - a.time);
  const item = p => {
    const d = new Date(p.time * 1000);
    return `<div class="up"><div class="ud"><b>${d.getMonth()+1}/${d.getDate()}</b><span>周${WEEK[d.getDay()]}</span></div>
      <div class="ub">${p.cat === 'upcoming' ? '<span class="badge upcoming">预告</span>' : ''}${link(p, 'ut', esc(p.title))}
      <div class="mute">${esc(p.club)}${p.venue ? ' · 📍' + esc(p.venue) : ''} · ${SRC[p.src] || ''}</div></div></div>`;
  };
  $('side').innerHTML = `<div class="sidehead">🎭 演出快讯 <span class="mute">最近 3 个月 · ${ps.length}</span></div>`
    + (ps.length ? ps.slice(0, 120).map(item).join('') : '<div class="mute" style="padding:12px 0">最近 3 个月暂无演出消息</div>');
}

// ---------- 下拉选项（级联） ----------
function fillSelect(id, values, label) {
  const el = $(id), cur = el.value;
  el.innerHTML = `<option value="">${label}</option>` + values.map(([v, n]) => `<option value="${esc(v)}">${esc(v)}${n ? ` (${n})` : ''}</option>`).join('');
  if (cur && !values.some(([v]) => v === cur)) el.innerHTML += `<option>${esc(cur)}</option>`;
  el.value = cur;
}
function counts(items, key) {
  const m = new Map();
  items.forEach(x => [].concat(x[key] || []).forEach(v => v && m.set(v, (m.get(v) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh'));
}
function refreshOptions() {
  const f = F();
  fillSelect('city', counts(D.clubs.filter(c => !f.province || c.province === f.province), 'city').map(([v]) => [v]), '全部城市');
  fillSelect('school', counts(D.clubs.filter(c => (!f.province || c.province === f.province) && (!f.city || c.city === f.city)
    && (!f.level || c.level === f.level)), 'school').map(([v]) => [v]), '全部学校');
  // 剧目下拉只统计当前栏目会显示的内容（含快捷分类），避免显示 (1) 点进去却为空
  const src = tab === 'videos' ? D.videos.filter(v => (!Q.vkind || v.kind === Q.vkind) && (!Q.vdur || durBucket(v.dur) === Q.vdur))
    : tab === 'big' ? D.videos.filter(v => v.kind === '大戏')
    : tab === 'posts' ? D.posts.filter(p => (!Q.pcat || (Q.pcat === 'Repo' ? p.repo : Q.pcat === '演出相关' ? p.cat !== 'other' && !p.repo : CAT[p.cat] === Q.pcat && !p.repo))
                                   && (!Q.psrc || (Q.psrc === '非官方' ? p.unofficial : SRC[p.src] === Q.psrc && !p.unofficial)))
    : [...D.posts, ...D.videos];
  fillSelect('show', counts(src.filter(x => match(x, {...f, show: ''}, tab === 'posts' ? PF : VF)), 'shows').slice(0, 200), '全部剧目');
}

// 筛选条件写进网址：复制链接分享给朋友，打开就是同样的页面
function syncUrl() {
  const q = new URLSearchParams();
  FILTERS.forEach(k => $(k).value && q.set(k, $(k).value));
  if ($('kw').value.trim()) q.set('kw', $('kw').value.trim());
  history.replaceState(null, '', (q.toString() ? '?' + q : location.pathname) + '#' + tab);
}
function restoreUrl() {
  const q = new URLSearchParams(location.search);
  FILTERS.forEach(k => { const v = q.get(k); if (v) { $(k).innerHTML += `<option>${esc(v)}</option>`; $(k).value = v; } });
  if (q.get('kw')) $('kw').value = q.get('kw');
}

function render(keepPage) {
  if (!keepPage) shown = PAGE;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (needVideos() && !videosLoaded) return ensureVideos();
  refreshOptions();
  const f = F();
  $('view').innerHTML = {big: viewBig, posts: viewPosts, videos: viewVideos, clubs: viewClubs, submit: viewSubmit, wish: viewWish}[tab](f);
  if (tab === 'submit') $('sbSend').onclick = sendSubmit;
  if (tab === 'wish' && $('wq')) $('wq').oninput = wishSuggest;
  if (!$('side').childElementCount) renderSide();  // 不随筛选变化，只渲染一次
  syncUrl();
  observeMore();
}
// 滚到列表底部时追加下一页
const moreObs = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { shown += PAGE; render(true); } }, {rootMargin: '600px'});
function observeMore() { moreObs.disconnect(); if ($('more')) moreObs.observe($('more')); }

// ---------- 评论（卡片内展开） ----------
async function toggleComments(btn) {
  const box = btn.closest('.cbar').nextElementSibling, url = btn.dataset.comment, id = itemId(url);
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="clist mute">加载中…</div>
    <div class="cform"><input class="cname" placeholder="昵称（可不填，默认“匿名”）" maxlength="20">
    <textarea class="cbody" placeholder="说点什么…（匿名，最多 500 字）" maxlength="500"></textarea>
    <button class="btn csend">发表</button></div>`;
  const list = box.querySelector('.clist');
  const load = async () => {
    try {
      const cs = await sb(`comments?select=name,body,created_at&item=eq.${id}&order=created_at.desc&limit=100`);
      CCOUNT[id] = cs.length;
      btn.textContent = '💬 评论' + (cs.length ? ' ' + cs.length : '');
      list.innerHTML = cs.length ? cs.map(c => `<div class="cm"><b>${esc(c.name || '匿名')}</b> <span class="mute">${new Date(c.created_at).toLocaleString('zh-CN', {hour12: false})}</span><div>${esc(c.body)}</div></div>`).join('') : '还没有评论，来说第一句吧';
    } catch (e) { list.textContent = '评论加载失败'; }
  };
  box.querySelector('.csend').onclick = async e => {
    const body = box.querySelector('.cbody').value.trim();
    if (!body) return;
    e.target.disabled = true;
    try {
      await sb('comments', {method: 'POST', body: JSON.stringify({item: id, url: url.split('?')[0], name: box.querySelector('.cname').value.trim().slice(0, 20), body: body.slice(0, 500)})});
      box.querySelector('.cbody').value = ''; await load();
    } catch (err) { alert('发表失败，请稍后再试'); }
    e.target.disabled = false;
  };
  load();
}

// ---------- 分享 ----------
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200); }
$('shareBtn').onclick = async () => {
  const f = F(), what = f.show ? `《${f.show}》的校园版本` : f.school ? `${f.school}的音乐剧` : '全国校园音乐剧';
  const data = {title: '不务正剧 · NOT JUST A MUSICAL', text: `学可以不上，剧不能不看。来看${what}👉`, url: location.href};
  if (navigator.share) { try { await navigator.share(data); return; } catch (e) {} }
  try { await navigator.clipboard.writeText(`${data.text} ${data.url}`); toast('链接已复制，快去分享给剧友吧 🎭'); }
  catch (e) { prompt('复制这个链接分享：', data.url); }
};

// ---------- 事件 ----------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
FILTERS.forEach(id => $(id).addEventListener('input', () => render()));
let kwTimer, renderTimer;
$('kw').addEventListener('input', () => {
  clearTimeout(renderTimer); renderTimer = setTimeout(render, 250);
  clearTimeout(kwTimer);
  const q = $('kw').value.trim();
  if (q.length >= 2) kwTimer = setTimeout(() => track('searches', {q: q.slice(0, 40)}), 1500);
});
$('reset').onclick = () => { [...FILTERS, 'kw'].forEach(id => $(id).value = ''); Object.assign(Q, {vkind: '', vdur: '', pcat: '', psrc: ''}); render(); };
document.addEventListener('click', e => {
  const t = e.target.closest('[data-track]');
  if (t) track('clicks', {item: itemId(t.dataset.track), url: t.dataset.track.split('?')[0]});
  const pe = e.target.closest('[data-wper]');
  if (pe) { WPER = pe.dataset.wper; render(true); return; }
  const w = e.target.closest('[data-wish]');
  if (w) { vote(w); return; }
  const c = e.target.closest('[data-comment]');
  if (c) { e.preventDefault(); toggleComments(c); return; }
  const q = e.target.closest('[data-q]');
  if (q) { Q[q.dataset.q] = Q[q.dataset.q] === q.dataset.v && q.dataset.v !== '' && q.dataset.q !== 'vsort' ? '' : q.dataset.v; render(); return; }
  const k = e.target.closest('[data-kw]');
  if (k) { $('kw').value = k.dataset.kw; render(); return; }
  const s = e.target.closest('[data-show]');
  if (s) {
    e.preventDefault();
    const v = s.dataset.show;
    const off = s.classList.contains('stile') && $('show').value === v;  // 再点一次剧目方块取消筛选
    if (!off && ![...$('show').options].some(o => o.value === v)) $('show').innerHTML += `<option>${esc(v)}</option>`;
    $('show').value = off ? '' : v;
    render();
    if (!s.classList.contains('stile')) window.scrollTo({top: 0, behavior: 'smooth'});
  }
});

// ---------- 留言板 + 弹幕（存在 comments 表，item = 'guestbook'） ----------
const GB = 'guestbook';
let gbMsgs = [], dmPool = [], dmIdx = 0, dmTimer = null;
const laneAt = {};
const DM_COLORS = ['#ff8fbf', '#ffc94a', '#7ff0ff', '#c9a6ff', '#ffffff', '#ffb27a'];
async function loadGuestbook() {
  if (!SB) return;
  try { gbMsgs = await sb(`comments?select=name,body,created_at&item=eq.${GB}&order=created_at.desc&limit=150`); } catch (e) { gbMsgs = []; }
  try {  // 各视频/动态下面的评价，也进弹幕
    const rs = await sb(`comments?select=item,body&item=neq.${GB}&order=created_at.desc&limit=150`);
    dmPool = gbMsgs.map(m => ({kind: 'gb', body: m.body})).concat(rs.map(r => ({kind: 'review', item: r.item, body: r.body})))
      .sort(() => Math.random() - .5);
  } catch (e) { dmPool = gbMsgs.map(m => ({kind: 'gb', body: m.body})); }
  $('gbList').innerHTML = gbMsgs.length ? gbMsgs.map(m => `<div class="cm"><b>${esc(m.name || '匿名剧友')}</b> <span class="mute">${new Date(m.created_at).toLocaleString('zh-CN', {hour12: false})}</span><div>${esc(m.body)}</div></div>`).join('')
    : '还没有留言，来发第一条弹幕吧 🎉';
  startDanmaku();
}
function shoot(m, mine) {
  const layer = $('danmaku');
  if (!layer || document.hidden || !$('dmOn').checked) return;
  // 挑最久没用过的轨道（并列时随机），避免弹幕重叠
  const lanes = 5, t = Date.now();
  const lane = [...Array(lanes).keys()].sort((a, b) => (laneAt[a] || 0) - (laneAt[b] || 0) || Math.random() - .5)[0];
  laneAt[lane] = t;
  const el = document.createElement('div');
  el.className = 'dm' + (mine ? ' mine' : '');
  el.textContent = dmText(m);
  el.style.top = (8 + lane * (84 / lanes)) + '%';
  el.style.color = mine ? '#1a0f24' : DM_COLORS[Math.floor(Math.random() * DM_COLORS.length)];
  el.style.animationDuration = (9 + Math.min(8, m.body.length / 8) + Math.random() * 3) + 's';
  el.addEventListener('animationend', () => el.remove());
  layer.appendChild(el);
}
// 「留言 - xxx」/「《剧目》评价 - xxx」；评价对应的剧目从已加载的数据里查
function dmText(m) {
  if (m.kind !== 'review') return '留言 - ' + m.body;
  const x = [...D.videos, ...D.posts].find(v => itemId(v.url) === m.item);
  const name = x ? (x.shows && x.shows.length ? `《${x.shows[0]}》` : x.title.slice(0, 14)) : '';
  return `${name}评价 - ${m.body}`;
}
function startDanmaku() {
  clearInterval(dmTimer);
  if (!dmPool.length) return;
  dmTimer = setInterval(() => { shoot(dmPool[dmIdx++ % dmPool.length]); }, 1600);
}
$('gbBtn').onclick = () => { $('gb').hidden = !$('gb').hidden; if (!$('gb').hidden) loadGuestbook(); };
$('gbClose').onclick = () => $('gb').hidden = true;
$('dmOn').onchange = () => { if (!$('dmOn').checked) $('danmaku').innerHTML = ''; };
$('gbSend').onclick = async () => {
  const body = $('gbBody').value.trim();
  if (!body) return;
  $('gbSend').disabled = true;
  const m = {name: $('gbName').value.trim().slice(0, 20), body: body.slice(0, 100), kind: 'gb'};
  try {
    await sb('comments', {method: 'POST', body: JSON.stringify({item: GB, url: 'guestbook', ...m})});
    $('gbBody').value = '';
    shoot(m, true);
    toast('弹幕已发射 🚀');
    await loadGuestbook();
  } catch (e) { alert('发送太频繁或网络问题，请稍后再试'); }
  $('gbSend').disabled = false;
};
if (!SB) $('gbBtn').hidden = true;

// 访问统计：浏览器里随机生成的匿名 ID，不含任何个人信息
if (SB) {
  let vid = localStorage.getItem('vid');
  if (!vid) { vid = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('vid', vid); }
  track('visits', {vid});
}

restoreUrl();
fetch(`data/meta.json?t=${Date.now()}`).then(r => r.json()).catch(() => ({})).then(async meta => {
  VER = meta.ver || '';
  const [posts, clubs] = await Promise.all([getData('posts'), getData('clubs')]);
  Object.assign(D, {posts: posts || [], clubs: clubs || [], meta: meta || {}});
  $('updated').textContent = D.meta.updated
    ? `${D.meta.n_clubs} 个剧社 · ${D.meta.n_big || 0} 部大戏 · ${D.meta.n_videos || 0} 个演出视频 · 内容更新于 ${new Date(D.meta.updated * 1000).toLocaleString('zh-CN', {hour12: false})}`
      + ` · 🔥 热度（观看+评论）每小时更新一次（下次 ${String((new Date().getHours() + 1) % 24).padStart(2, '0')}:00）`
    : '暂无数据';
  fillSelect('province', counts(D.clubs, 'province'), '全部地区');
  render();
  loadStats();
  loadGuestbook();
});
