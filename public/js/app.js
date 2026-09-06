// 公共脚本：导航、请求封装、工具函数
window.PAGE = window.PAGE || 'dashboard';

const NAV_ITEMS = [
  { id: 'dashboard', href: '/', label: '仪表盘' },
  { id: 'review', href: '/review', label: '开始复习' },
  { id: 'knowledge', href: '/knowledge', label: '知识点' },
  { id: 'notes', href: '/notes', label: '笔记录入' },
  { id: 'schedule', href: '/schedule', label: '时间安排' },
  { id: 'errorbook', href: '/errorbook', label: '错题本' },
  { id: 'settings', href: '/settings', label: '设置' }
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(iso) {
  if (!iso) return '未安排';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function toast(msg, type) {
  const colors = {
    ok: 'bg-emerald-600',
    err: 'bg-rose-600',
    info: 'bg-slate-800'
  };
  const box = document.createElement('div');
  box.className = 'fixed top-5 right-5 z-[100] ' + (colors[type] || colors.info) + ' text-white text-sm px-4 py-3 rounded-xl shadow-lg animate-[fadein_.2s]';
  box.textContent = msg;
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3500);
}

async function api(path, opts) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || '请求失败 (' + res.status + ')');
  return data;
}

function injectNav() {
  const nav = document.getElementById('nav-root');
  if (!nav) return;
  const active = NAV_ITEMS.find((n) => n.id === window.PAGE);
  const items = NAV_ITEMS.map((n) => {
    const isActive = n.id === window.PAGE;
    return `<a href="${n.href}" class="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
      isActive ? 'bg-indigo-600 text-white shadow' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
    }">
      ${n.label}
      ${n.id === 'review' ? '<span class="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300" id="due-badge" style="display:none">0</span>' : ''}
    </a>`;
  }).join('');
  const mobileItems = NAV_ITEMS.map((n) => {
    const isActive = n.id === window.PAGE;
    return `<a href="${n.href}" class="flex flex-col items-center justify-center gap-1 py-2.5 ${isActive ? 'text-white' : 'text-slate-400'}">
      <span class="text-[10px] leading-none whitespace-nowrap ${isActive ? 'font-semibold' : ''}">${n.label}</span>
      ${n.id === 'review' ? '<span class="text-[9px] leading-none px-1 py-0.5 rounded-full bg-amber-500/20 text-amber-300 mt-0.5" id="due-badge-m" style="display:none">0</span>' : ''}
    </a>`;
  }).join('');
  nav.innerHTML = `
    <aside class="hidden md:flex fixed inset-y-0 left-0 w-60 bg-slate-900 flex-col z-40">
      <div class="px-5 py-5 border-b border-slate-800">
        <div class="text-white text-xl leading-tight tracking-wide brand-poem">念念</div>
        <div class="text-slate-500 text-xs mt-1">念念不忘 · 必有回响</div>
      </div>
      <nav class="flex-1 px-3 py-4 space-y-1 overflow-y-auto">${items}</nav>
      <div class="px-5 py-4 border-t border-slate-800 text-[11px] text-slate-500">
        ${active ? active.label : ''}<br>v0.1 本地运行
      </div>
    </aside>
    <header class="mobile-topbar md:hidden fixed top-0 inset-x-0 z-40 bg-slate-900/95 backdrop-blur flex items-center justify-between px-4 border-b border-slate-800">
      <div>
        <div class="text-white text-lg leading-tight tracking-wide brand-poem">念念</div>
        <div class="text-slate-500 text-[10px] leading-none mt-0.5">念念不忘 · 必有回响</div>
      </div>
      <span class="text-xs text-slate-300">${active ? active.label : ''}</span>
    </header>
    <nav class="mobile-bottombar md:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-900/95 backdrop-blur border-t border-slate-800 grid grid-cols-7">${mobileItems}</nav>
    <main class="md:ml-60 min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8"></main>`;
  const main = document.querySelector('main');
  const content = document.getElementById('page-content');
  if (content) {
    main.appendChild(content);
    content.classList.remove('page-enter');
    void content.offsetWidth;
    content.classList.add('page-enter');
  }
  loadDueBadge();
}

async function loadDueBadge() {
  try {
    const d = await api('/review/due');
    const n = d.tasks.length;
    ['due-badge', 'due-badge-m'].forEach((id) => {
      const badge = document.getElementById(id);
      if (badge) {
        badge.style.display = n > 0 ? 'inline-block' : 'none';
        badge.textContent = n;
      }
    });
  } catch (e) {}
}

function spinner(text) {
  return `<div class="flex items-center justify-center gap-3 py-12 text-slate-500 text-sm">
    <div class="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
    ${esc(text || '加载中…')}</div>`;
}

function empty(text) {
  return `<div class="text-center py-12 text-slate-400 text-sm">${esc(text || '暂无数据')}</div>`;
}

function modal(html, onClose) {
  const wrap = document.createElement('div');
  wrap.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.innerHTML = `<div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">${html}</div>`;
  function close() { wrap.remove(); if (onClose) onClose(); }
  document.body.appendChild(wrap);
  wrap.querySelector('[data-close]')?.addEventListener('click', close);
  return { el: wrap, close };
}

function progressBar(rate) {
  const color = rate >= 80 ? 'bg-emerald-500' : rate >= 50 ? 'bg-indigo-500' : rate >= 25 ? 'bg-amber-500' : 'bg-rose-500';
  return `<div class="w-full bg-slate-200 rounded-full h-2"><div class="${color} h-2 rounded-full" style="width:${Math.min(100, Math.max(0, rate))}%"></div></div>`;
}

function init() {
  injectNav();
}

document.addEventListener('DOMContentLoaded', init);
// ---------- 富文本渲染：代码块高亮 ----------

// 把文本中的 ```lang ... ``` 代码块渲染为带高亮的 <pre><code>
function renderRich(text) {
  const raw = String(text == null ? '' : text);
  let html = '<div class="rich-text">';
  const re = /```([\w#+-]*)[ \t]*\r?\n?([\s\S]*?)```[ \t]*\r?\n?/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) html += esc(raw.slice(last, m.index));
    const lang = m[1] || 'plain';
    html += '<pre class="code-block"><code class="language-' + esc(lang) + '">' + esc(m[2]) + '</code></pre>';
    last = m.index + m[0].length;
  }
  if (last < raw.length) html += esc(raw.slice(last));
  return html + '</div>';
}
// 对容器内的代码块执行 Prism 高亮
function highlightBlocks(root) {
  const el = root || document;
  if (!window.Prism) return;
  el.querySelectorAll('pre.code-block code').forEach((c) => {
    try { Prism.highlightElement(c); } catch (e) {}
  });
}
// ---------- 交互特效：点击涟漪 + 页面切换 ----------
function spawnRipple(e) {
  const host = e.target.closest('a[href], button, [data-ripple]');
  if (!host) return;
  if (!host.classList.contains('ripple-host')) host.classList.add('ripple-host');
  const rect = host.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.width = span.style.height = size + 'px';
  span.style.left = e.clientX - rect.left - size / 2 + 'px';
  span.style.top = e.clientY - rect.top - size / 2 + 'px';
  host.appendChild(span);
  span.addEventListener('animationend', () => span.remove());
}
document.addEventListener('pointerdown', spawnRipple, true);

function pageOut(cb) {
  const main = document.querySelector('main');
  if (!main) return cb();
  main.classList.add('page-out');
  setTimeout(cb, 230);
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href === '#' || href.startsWith('#') || href.startsWith('/api/') || href.startsWith('//')) return;
  if (a.target && a.target !== '_self') return;
  if (a.hasAttribute('download')) return;
  if (a.dataset.noTransition !== undefined) return;
  let url;
  try { url = new URL(href, location.origin); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  e.preventDefault();
  pageOut(() => { location.href = url.href; });
});

// ---------- 插入代码工具条 ----------
const CODE_LANGS = ['go', 'c', 'cpp', 'java', 'python', 'javascript', 'typescript', 'sql', 'bash', 'json', 'css', 'markdown', 'plain'];
function insertCodeBlock(ta, lang) {
  if (!ta) return;
  const l = lang || 'plain';
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  const block = '```' + l + '\n' + (sel || '') + '\n```';
  const start = ta.selectionStart;
  ta.setRangeText(block, start, ta.selectionEnd, 'end');
  ta.focus();
  const cur = start + l.length + 4;
  ta.setSelectionRange(cur, cur);
}
function addCodeToolbar(ta) {
  if (!ta || ta.dataset.codebar) return;
  ta.dataset.codebar = '1';
  const wrap = document.createElement('div');
  wrap.className = 'flex items-center gap-2 mb-1.5';
  const sel = document.createElement('select');
  sel.className = 'text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white focus:ring-2 focus:ring-indigo-500 outline-none';
  CODE_LANGS.forEach((l) => {
    const o = document.createElement('option');
    o.value = l;
    o.textContent = l === 'plain' ? '纯文本' : l;
    sel.appendChild(o);
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'text-xs bg-slate-800 text-white px-3 py-1.5 rounded-lg hover:bg-slate-700';
  btn.textContent = '插入代码';
  btn.onclick = () => insertCodeBlock(ta, sel.value);
  wrap.appendChild(sel);
  wrap.appendChild(btn);
  ta.parentNode.insertBefore(wrap, ta);
}

// ================= 跨页常驻背景音乐（浮动迷你播放器） =================
// 念念是多页应用，切页会销毁 index.html 的音乐 <audio>。
// 这里在每页都运行的 app.js 里放一个迷你播放器 + 用 sessionStorage 记住
// 当前曲目与播放进度，翻页后自动恢复，做到“切页面不断音乐”。
(function () {
  if (window.PAGE === 'dashboard') return; // 首页用卡片播放器管理，这里不接管
  const DB_NAME = 'review-planner-music';
  const STORE = 'tracks';
  const MKEY = 'niannian-music';
  const audio = new Audio();
  audio.preload = 'metadata';
  let songs = []; // [{id, name, url}]
  let cur = -1;
  let playMode = 0; // 0 顺序 / 1 随机 / 2 单曲
  try { const mm = parseInt(localStorage.getItem('niannian-playmode') || '0'); playMode = (mm >= 0 && mm <= 2) ? mm : 0; } catch (e) { playMode = 0; }
  function nextIndex() {
    if (songs.length <= 1) return cur;
    if (playMode === 1) { let n; do { n = Math.floor(Math.random() * songs.length); } while (n === cur); return n; }
    return (cur + 1) % songs.length;
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function getAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        r.onsuccess = function () { resolve(r.result || []); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function persist() {
    try {
      if (cur >= 0 && songs[cur]) sessionStorage.setItem(MKEY, JSON.stringify({ id: songs[cur].id, time: audio.currentTime || 0, playing: !audio.paused }));
    } catch (e) {}
  }
  function setLabel() {
    const t = document.getElementById('mini-title');
    if (t) t.textContent = songs[cur] ? songs[cur].name : '未播放';
  }
  function refreshIcon() {
    const b = document.getElementById('mini-play');
    if (b) b.textContent = audio.paused ? '▶' : '⏸';
  }
  function play(i) {
    if (i < 0 || i >= songs.length) return;
    cur = i;
    audio.src = songs[i].url;
    audio.play().catch(function () {});
    setLabel(); refreshIcon(); persist();
  }
  function makeSong(r) { return { id: r.id, name: r.name, url: URL.createObjectURL(r.blob) }; }
  function buildPanel() {
    if (!songs.length) return;
    const panel = document.createElement('div');
    panel.id = 'mini-music';
    panel.className = 'fixed bottom-16 md:bottom-6 right-4 z-50 bg-slate-900/95 text-white rounded-2xl shadow-2xl px-3 py-2 flex items-center gap-3 border border-white/10';
    panel.innerHTML =
      '<div class="min-w-0 max-w-[150px]"><div class="text-[10px] text-slate-400 leading-tight">背景音乐</div>' +
      '<div class="text-xs truncate" id="mini-title">' + (songs[cur] ? esc(songs[cur].name) : '未播放') + '</div></div>' +
      '<div class="flex items-center gap-1">' +
      '<button id="mini-prev" class="w-7 h-7 rounded-full hover:bg-white/10 text-sm">⏮</button>' +
      '<button id="mini-play" class="w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 text-base" title="播放/暂停">' + (audio.paused ? '▶' : '⏸') + '</button>' +
      '<button id="mini-next" class="w-7 h-7 rounded-full hover:bg-white/10 text-sm">⏭</button>' +
      '</div>';
    document.body.appendChild(panel);
    panel.querySelector('#mini-play').addEventListener('click', function () {
      if (cur < 0 && songs.length) { play(0); }
      else if (audio.paused) { audio.play().catch(function () {}); refreshIcon(); persist(); }
      else { audio.pause(); }
    });
    panel.querySelector('#mini-next').addEventListener('click', function () { if (songs.length) play(nextIndex()); });
    panel.querySelector('#mini-prev').addEventListener('click', function () { if (songs.length) play((cur - 1 + songs.length) % songs.length); });
    audio.addEventListener('play', refreshIcon);
    audio.addEventListener('pause', refreshIcon);
    audio.addEventListener('ended', function () {
      if (!songs.length) return;
      if (playMode === 2) { audio.currentTime = 0; audio.play().catch(function () {}); persist(); return; }
      play(nextIndex());
    });
    audio.addEventListener('timeupdate', persist);
    window.addEventListener('pagehide', persist);
  }
  function getTrack(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  // 恢复上次播放：先按 id 取回正在播的那首，快速接上（仅当之前是播放状态才自动续播）；再后台加载完整列表
  (function resume() {
    let st = null;
    try { st = JSON.parse(sessionStorage.getItem(MKEY) || 'null'); } catch (e) {}
    function loadFullList() {
      getAll().then(function (records) {
        const full = (records || []).filter(function (r) { return r && r.blob; }).map(makeSong);
        const cid = (songs && songs[cur]) ? songs[cur].id : null;
        if (full.length) {
          songs = full;
          if (cid != null) { const j = songs.findIndex(function (s) { return String(s.id) === String(cid); }); if (j >= 0) cur = j; }
          setLabel(); refreshIcon();
        }
      });
    }
    if (st && st.id != null) {
      getTrack(st.id).then(function (rec) {
        if (rec && rec.blob) {
          songs = [makeSong(rec)]; cur = 0;
          audio.src = songs[0].url;
          if (st.time) { try { audio.currentTime = st.time; } catch (e) {} }
          if (st.playing) audio.play().catch(function () {});
        }
        buildPanel();
        loadFullList();
      });
    } else {
      getAll().then(function (records) { songs = (records || []).filter(function (r) { return r && r.blob; }).map(makeSong); buildPanel(); });
    }
  })();
})();
