/* Fonctions partagées : appli, page de partage, connexion */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = b => { if (b == null) return '—'; const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? (b < 10 ? b.toFixed(1) : Math.round(b)).toString().replace('.', ',') : b) + ' ' + u[i]; };
const fmtDate = t => {
  if (!t) return '—';
  const d = new Date(t), n = new Date(), diff = (n - d) / 1000;
  if (diff < 60) return "À l'instant";
  if (diff < 3600) return `Il y a ${Math.floor(diff / 60)} min`;
  if (d.toDateString() === n.toDateString()) return "Aujourd'hui, " + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Hier, ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
};
const fmtFull = t => (t ? new Date(t).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) : '—');
const initials = n => String(n || '?').split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('');

/* Thème clair / sombre */
const Theme = {
  get() { try { return localStorage.getItem('ed-theme') || 'auto'; } catch (e) { return 'auto'; } },
  apply(t = Theme.get()) {
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  },
  set(t) { try { localStorage.setItem('ed-theme', t); } catch (e) { } Theme.apply(t); },
};
Theme.apply();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => Theme.apply());

/* Appels API */
async function api(url, opts = {}) {
  const o = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: { 'X-ED': '1' }, credentials: 'same-origin' };
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData || opts.raw) o.body = opts.body;
    else { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  }
  const r = await fetch(url, o);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !opts.no401 && !j.needPassword) { location.href = 'login?next=' + encodeURIComponent(location.pathname + location.hash); throw new Error('Session expirée'); }
  if (!r.ok) { const e = new Error(j.error || 'Erreur ' + r.status); e.status = r.status; e.data = j; throw e; }
  return j;
}
function xhrUpload(url, fd, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', url); x.setRequestHeader('X-ED', '1');
    x.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) { } x.status < 300 ? res(j) : rej(new Error(j.error || 'Erreur ' + x.status)); };
    x.onerror = () => rej(new Error('Connexion interrompue'));
    x.send(fd);
    xhrUpload.current = x;
  });
}

/* Types de fichiers et icônes */
function kind(it) {
  if (it.type === 'folder') return 'folder';
  const m = it.mime || '', e = it.ext || (it.name.includes('.') ? it.name.split('.').pop().toLowerCase() : '');
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif'].includes(e)) return 'image';
  if (m.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(e)) return 'video';
  if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx', 'docm', 'odt', 'rtf', 'dotx', 'ott'].includes(e)) return 'doc';
  if (['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'xltx'].includes(e)) return 'sheet';
  if (['ppt', 'pptx', 'pptm', 'odp', 'ppsx', 'potx'].includes(e)) return 'slide';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(e)) return 'archive';
  if (m.startsWith('text/') || ['txt', 'md', 'json', 'js', 'ts', 'html', 'css', 'php', 'lua', 'py', 'xml', 'yml', 'yaml', 'sql', 'log', 'ini', 'cfg', 'sh', 'bat', 'ps1', 'env', 'conf'].includes(e)) return 'text';
  return 'file';
}
const KIND = {
  folder: { c: '#000091', l: 'Dossier' }, image: { c: '#8b3d85', l: 'Image', t: 'IMG' }, video: { c: '#a3243a', l: 'Vidéo', t: 'VID' },
  audio: { c: '#b34000', l: 'Audio', t: 'SON' }, pdf: { c: '#ce0500', l: 'PDF', t: 'PDF' }, doc: { c: '#2457d6', l: 'Document', t: 'DOC' },
  sheet: { c: '#18753c', l: 'Classeur', t: 'XLS' }, slide: { c: '#c75100', l: 'Présentation', t: 'PPT' }, archive: { c: '#6e4f3a', l: 'Archive', t: 'ZIP' },
  text: { c: '#3a3a3a', l: 'Texte', t: 'TXT' }, file: { c: '#666', l: 'Fichier', t: '' },
};
function icon(it, s = 24) {
  const k = kind(it);
  if (k === 'folder') return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path fill="${it.color ? COLOR_HEX[it.color] : 'var(--blue)'}" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>${it.shared ? '<circle cx="16.5" cy="14.5" r="3.6" fill="var(--bg-raised)"/><path fill="var(--blue)" d="M16.5 12.3a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zm0 2.6c1 0 2.2.5 2.2 1.1v.6h-4.4V16c0-.6 1.2-1.1 2.2-1.1z"/>' : ''}</svg>`;
  const { c, t } = KIND[k];
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path fill="${c}" d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8z"/><path fill="#fff" opacity=".4" d="M14 2v6h6z"/>${t ? `<text x="12" y="17.6" text-anchor="middle" font-size="5.4" font-weight="800" fill="#fff" font-family="Arial,sans-serif">${t}</text>` : ''}</svg>`;
}
const COLOR_HEX = { red: '#e1000f', orange: '#e4794a', yellow: '#d6a400', green: '#18753c', blue: '#2457d6', purple: '#8b3d85', grey: '#7a7a7a' };
const COLOR_L = { red: 'Rouge', orange: 'Orange', yellow: 'Jaune', green: 'Vert', blue: 'Bleu', purple: 'Violet', grey: 'Gris' };
const SVG = (d, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d}</svg>`;
const P = {
  close: '<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/>',
  folder: '<path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>',
  newFolder: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3z"/>',
  upload: '<path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8zm-1 11v4h-2v-4H8l4-4 4 4z"/>',
  uploadDir: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-8 3 4 4h-3v4h-2v-4H8z"/>',
  cloud: '<path d="M19.4 10A7.5 7.5 0 0 0 5.4 8 6 6 0 0 0 6 20h13a5 5 0 0 0 .4-10zM14 13v4h-4v-4H7l5-5 5 5z"/>',
  home: '<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>',
  recent: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 11h-5v-2h3V6h2z"/>',
  share: '<path d="M18 16a3 3 0 0 0-2 .8L8.9 12.7a3 3 0 0 0 0-1.4L16 7.2A3 3 0 1 0 15 5l-7 4.1a3 3 0 1 0 0 5.8l7.1 4.2A3 3 0 1 0 18 16z"/>',
  people: '<path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0h-1c1.2.9 2 2 2 3.5V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z"/>',
  link: '<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 1 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z"/>',
  star: '<path d="M12 17.3 18.2 21l-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.5 14l-1.7 7z"/>',
  starO: '<path d="m22 9.2-7.2-.6L12 2 9.2 8.6 2 9.2 7.5 14l-1.7 7 6.2-3.7 6.2 3.7-1.6-7zm-10 6.2-3.8 2.3 1-4.3-3.3-2.9 4.4-.4L12 6.1l1.7 4.1 4.4.4-3.3 2.9 1 4.3z"/>',
  trash: '<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/>',
  restore: '<path d="M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 2.1 5L6.7 18.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z"/>',
  dl: '<path d="M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z"/>',
  edit: '<path d="M3 17.3V21h3.8L17.8 9.9 14 6.2zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8L19 8.8z"/>',
  move: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 12v-3h-4v-4h4V8l5 5z"/>',
  copy: '<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z"/>',
  info: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>',
  open: '<path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-7h-2zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3z"/>',
  eye: '<path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',
  more: '<path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  grid: '<path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/>',
  list: '<path d="M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z"/>',
  sort: '<path d="M7 4v13H4l4 4 4-4H9V4zm7 3h3v13h2V7h3l-4-4z"/>',
  menu: '<path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/>',
  search: '<path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/>',
  lock: '<path d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 1 1 6 0v2H9zm3 11a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>',
  admin: '<path d="M12 1 3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5zm0 6a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zm4.5 9.5h-9v-1c0-1.5 3-2.3 4.5-2.3s4.5.8 4.5 2.3z"/>',
  user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4z"/>',
  moon: '<path d="M12 3a9 9 0 1 0 9 9c0-.5 0-.9-.1-1.4A5.5 5.5 0 0 1 12.4 3H12z"/>',
  logout: '<path d="M10.1 15.6 11.5 17l5-5-5-5-1.4 1.4 2.6 2.6H3v2h9.7zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>',
  history: '<path d="M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.1 4-4H6a7 7 0 1 1 7 7 7 7 0 0 1-4.9-2.1l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z"/>',
  docx: '<path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9zM8 12h8v2H8zm0 4h8v2H8z"/>',
  check: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>',
  team: '<path d="M12 12.75c1.63 0 3.07.39 4.24.9A3 3 0 0 1 18 16.4V18H6v-1.6c0-1.18.68-2.26 1.76-2.73A10.2 10.2 0 0 1 12 12.75zM4 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm1.13 1.1A7 7 0 0 0 4 14c-.99 0-1.93.21-2.78.58A2 2 0 0 0 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29zM20 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm4 3.43a2 2 0 0 0-1.22-1.85A6.95 6.95 0 0 0 20 14c-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24zM12 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>',
  comment: '<path d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4zM18 14H6v-2h12zm0-3H6V9h12zm0-3H6V6h12z"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01a1.5 1.5 0 0 1 1.13-2.49H16a5 5 0 0 0 5-5c0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>',
  unzip: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-2 6h-2v2h2v2h-2v2h-2v-2h2v-2h-2v-2h2v-2h-2V8h2v2h2z"/>',
  camera: '<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>',
};

/* QR code généré dans le navigateur (si le serveur n'en fournit pas) */
function qrSvg(text) {
  if (!window.qrcode) return '';
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/* Notifications */
function toast(msg, type = '', actLabel, actFn) {
  const box = $('#toasts') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toasts', className: 'toasts' }));
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>${actLabel ? `<button>${esc(actLabel)}</button>` : ''}`;
  if (actLabel) t.querySelector('button').onclick = () => { actFn(); t.remove(); };
  box.appendChild(t);
  setTimeout(() => t.remove(), actLabel ? 7000 : 3500);
}

/* Fenêtres modales */
let modalOnClose = null;
function modal(html, cls = '') {
  let ov = $('#overlay');
  if (!ov) { ov = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'overlay', className: 'overlay' })); ov.innerHTML = '<div class="modal" id="modal" role="dialog" aria-modal="true"></div>'; ov.addEventListener('mousedown', e => { if (e.target === ov) closeModal(); }); }
  const m = $('#modal');
  m.className = 'modal ' + cls;
  m.innerHTML = `<div class="modal-h"><button type="button" onclick="closeModal()">Fermer ${SVG(P.close, 16)}</button></div>` + html;
  ov.classList.add('show');
  setTimeout(() => { const f = m.querySelector('[autofocus],input:not([type=checkbox]):not([type=radio]):not([readonly]),textarea'); if (f) { f.focus(); } }, 30);
  return m;
}
function closeModal() { const ov = $('#overlay'); if (!ov || !ov.classList.contains('show')) return; ov.classList.remove('show'); const f = modalOnClose; modalOnClose = null; if (f) f(); }
const modalOpen = () => $('#overlay')?.classList.contains('show');
function confirmDlg(title, msg, okLabel, onOk, danger = true) {
  modal(`<div class="modal-b"><h2>${title}</h2><p>${msg}</p></div><div class="modal-f"><button class="btn btn-secondary" onclick="closeModal()">Annuler</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cfOk">${okLabel}</button></div>`);
  $('#cfOk').onclick = () => { closeModal(); onOk(); };
  setTimeout(() => $('#cfOk').focus(), 40);
}
function inputDlg(title, label, val, okLabel, onOk, opts = {}) {
  modal(`<form id="dlgf" novalidate><div class="modal-b"><h2>${title}</h2><div class="field"><label for="dlgi">${label}</label><input id="dlgi" type="${opts.type || 'text'}" value="${esc(val)}" autocomplete="off">${opts.hint ? `<div class="hint">${opts.hint}</div>` : ''}<div class="err" id="dlge"></div></div></div><div class="modal-f"><button type="button" class="btn btn-secondary" onclick="closeModal()">Annuler</button><button class="btn btn-primary">${okLabel}</button></div></form>`);
  const inp = $('#dlgi');
  setTimeout(() => { inp.focus(); const d = val.lastIndexOf('.'); opts.keepExt && d > 0 ? inp.setSelectionRange(0, d) : inp.select(); }, 40);
  $('#dlgf').onsubmit = async e => {
    e.preventDefault();
    const v = inp.value.trim();
    if (!v && !opts.allowEmpty) { $('#dlge').textContent = 'Ce champ est obligatoire.'; return; }
    if (opts.name && /[\\/:*?"<>|]/.test(v)) { $('#dlge').textContent = 'Caractères interdits : \\ / : * ? " < > |'; return; }
    try { await onOk(v); closeModal(); } catch (err) { $('#dlge').textContent = err.message; }
  };
}

/* Lecture récursive d'un glisser-déposer de dossiers */
async function readEntries(entry, prefix = '') {
  if (entry.isFile) return new Promise(r => entry.file(f => r([{ file: f, path: prefix + f.name }]), () => r([])));
  if (entry.isDirectory) {
    const rd = entry.createReader(); let all = [], batch;
    do { batch = await new Promise(r => rd.readEntries(r, () => r([]))); all = all.concat(batch); } while (batch.length);
    const out = [];
    for (const e of all) out.push(...await readEntries(e, prefix + entry.name + '/'));
    return out;
  }
  return [];
}
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].filter(i => i.kind === 'file');
  if (items.length && items[0].webkitGetAsEntry) {
    const entries = items.map(i => i.webkitGetAsEntry()).filter(Boolean);
    const out = []; for (const en of entries) out.push(...await readEntries(en));
    return out;
  }
  return [...dt.files].map(f => ({ file: f, path: f.name }));
}

/* Gestionnaire d'envois (file d'attente, une requête par fichier) */
const Uploader = {
  queue: [], running: false, cancelled: false,
  add(list, urlFor, onDone) {
    if (!list.length) return;
    const box = Uploader.box();
    box.classList.add('show');
    for (const f of list) {
      const li = document.createElement('li');
      li.innerHTML = `${icon({ name: f.file.name, type: 'file', mime: f.file.type }, 22)}<div><div class="name" style="font-size:14px;font-weight:500">${esc(f.path)}</div><div class="sub">${fmtSize(f.file.size)}</div><div class="pb"><i style="width:0"></i></div></div>`;
      $('ul', box).appendChild(li);
      Uploader.queue.push({ ...f, li, urlFor, onDone });
    }
    Uploader.title();
    if (!Uploader.running) Uploader.run();
  },
  box() {
    let b = $('#uploads');
    if (!b) {
      b = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'uploads', className: 'uploads' }));
      b.innerHTML = `<div class="uh"><span id="uptitle">Envoi</span><span style="display:flex;gap:4px"><button id="upCancel" title="Annuler les envois">Annuler</button><button id="upClose" title="Fermer">${SVG(P.close, 18)}</button></span></div><ul></ul>`;
      $('#upClose', b).onclick = () => { if (!Uploader.running) { b.classList.remove('show'); $('ul', b).innerHTML = ''; } else b.classList.remove('show'); };
      $('#upCancel', b).onclick = () => { Uploader.cancelled = true; Uploader.queue = []; xhrUpload.current?.abort(); };
    }
    return b;
  },
  done: 0, failed: 0,
  title() {
    const left = Uploader.queue.length + (Uploader.running ? 1 : 0);
    $('#uptitle').textContent = left ? `Envoi en cours — ${left} restant${left > 1 ? 's' : ''}` : `${Uploader.done} fichier${Uploader.done > 1 ? 's' : ''} envoyé${Uploader.done > 1 ? 's' : ''}${Uploader.failed ? `, ${Uploader.failed} échec(s)` : ''}`;
    $('#upCancel').style.display = left ? '' : 'none';
  },
  async run() {
    Uploader.running = true; Uploader.cancelled = false;
    const callbacks = new Set();
    while (Uploader.queue.length) {
      const job = Uploader.queue.shift();
      Uploader.title();
      const bar = $('.pb i', job.li);
      try {
        const CH = Uploader.chunk || 0, f = job.file;
        if (CH && f.size > CH) {
          // Envoi en plusieurs morceaux, réassemblés par le serveur
          const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()).replace(/[^a-z0-9-]/gi, '');
          const total = Math.ceil(f.size / CH);
          for (let i = 0; i < total; i++) {
            if (Uploader.cancelled) throw new Error('Envoi annulé');
            const fd = new FormData();
            fd.append('paths', job.path); fd.append('chunk_id', id); fd.append('chunk_index', i); fd.append('chunk_total', total);
            fd.append('files', f.slice(i * CH, (i + 1) * CH), f.name);
            await xhrUpload(job.urlFor(), fd, p => bar.style.width = Math.round((i + p) / total * 100) + '%');
          }
        } else {
          const fd = new FormData();
          fd.append('paths', job.path);
          fd.append('files', f, f.name);
          await xhrUpload(job.urlFor(), fd, p => bar.style.width = Math.round(p * 100) + '%');
        }
        bar.style.width = '100%'; job.li.classList.add('done'); Uploader.done++;
      } catch (e) {
        job.li.classList.add('fail'); bar.style.width = '100%'; Uploader.failed++;
        $('.sub', job.li).textContent = e.message;
        if (Uploader.cancelled) break;
      }
      if (job.onDone) callbacks.add(job.onDone);
    }
    Uploader.running = false;
    Uploader.title();
    callbacks.forEach(f => f());
    if (!Uploader.failed) setTimeout(() => { if (!Uploader.running) { $('#uploads').classList.remove('show'); $('#uploads ul').innerHTML = ''; Uploader.done = 0; } }, 4000);
    else Uploader.failed = 0, Uploader.done = 0;
  },
};
