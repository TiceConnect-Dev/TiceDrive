'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const archiver = require('archiver');
const mime = require('mime-types');
const contentDisposition = require('content-disposition');
const AdmZip = require('adm-zip');
const QRCode = require('qrcode');
const { db, DATA } = require('./db');
const totp = require('./totp');
const createIndexer = require('./textindex');
const mountDav = require('./dav');

/* ============================== Configuration ============================== */
function parseSize(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)[oB]?$/i);
  if (!m) return Number(s) || 0;
  return Math.round(parseFloat(m[1]) * 1024 ** ' KMGT'.indexOf((m[2] || ' ').toUpperCase()));
}
const trimSlash = s => String(s || '').replace(/\/+$/, '');
const C = {
  PORT: Number(process.env.PORT) || 3000,
  APP_NAME: process.env.APP_NAME || 'Espace Documents',
  APP_URL: trimSlash(process.env.APP_URL || 'http://localhost:3000'),
  INTERNAL_URL: trimSlash(process.env.APP_INTERNAL_URL || ''),
  OO_URL: trimSlash(process.env.ONLYOFFICE_URL || ''),
  OO_SECRET: process.env.ONLYOFFICE_JWT_SECRET || '',
  DEFAULT_QUOTA: parseSize(process.env.DEFAULT_QUOTA || '10G'),
  MAX_UPLOAD: parseSize(process.env.MAX_UPLOAD || '4G'),
  MAX_VERSIONS: Number(process.env.MAX_VERSIONS) || 20,
  TRASH_DAYS: Number(process.env.TRASH_DAYS) || 30,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || '',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
};
let SECRET = process.env.SECRET;
if (!SECRET) {
  const f = path.join(DATA, '.secret');
  if (fs.existsSync(f)) SECRET = fs.readFileSync(f, 'utf8').trim();
  else { SECRET = crypto.randomBytes(48).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}
const SECURE = C.APP_URL.startsWith('https');
const DS_BASE = C.INTERNAL_URL || C.APP_URL; // URL utilisée par OnlyOffice pour joindre l'appli

/* ============================== OnlyOffice ============================== */
const OO_TYPES = {
  word: ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'ott', 'rtf', 'txt', 'mht', 'epub', 'fb2', 'djvu', 'xps', 'oxps'],
  cell: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'ods', 'ots', 'csv'],
  slide: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'potm', 'odp', 'otp'],
  pdf: ['pdf'],
};
const OO_EDIT = ['docx', 'docm', 'dotx', 'odt', 'rtf', 'xlsx', 'xlsm', 'xltx', 'ods', 'csv', 'pptx', 'pptm', 'potx', 'odp'];
const docType = ext => Object.keys(OO_TYPES).find(k => OO_TYPES[k].includes(ext)) || null;
const ooEnabled = () => !!C.OO_URL;

/* ============================== Helpers ============================== */
const now = () => Date.now();
const uid = () => crypto.randomUUID().replace(/-/g, '');
const EXT = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const E = (status, msg, extra) => Object.assign(new Error(msg), { status, extra });
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fpath = id => path.join(DATA, 'files', id);
const vpath = id => path.join(DATA, 'versions', id);
const getItem = id => (id ? db.prepare('SELECT * FROM items WHERE id=?').get(String(id)) : null);
const getUser = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const setting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

const ancestorsStmt = db.prepare(`WITH RECURSIVE a(id, depth) AS (
  SELECT id, 0 FROM items WHERE id = ?
  UNION ALL SELECT i.parent_id, a.depth + 1 FROM items i JOIN a ON i.id = a.id WHERE i.parent_id IS NOT NULL
) SELECT items.* FROM a JOIN items ON items.id = a.id ORDER BY a.depth DESC`);
const descStmt = db.prepare(`WITH RECURSIVE d(id) AS (
  SELECT ? UNION ALL SELECT i.id FROM items i JOIN d ON i.parent_id = d.id
) SELECT items.* FROM d JOIN items ON items.id = d.id`);
const ancestors = id => ancestorsStmt.all(id);
const descendants = id => descStmt.all(id);
const indexer = createIndexer({ db, fpath: id => fpath(id), EXT: n => EXT(n) });
const markDirty = id => { db.prepare('UPDATE items SET indexed=0 WHERE id=?').run(id); indexer.enqueue(id); };

/* --- Espaces d'équipe : une équipe est un « compte » de type team, propriétaire de ses fichiers --- */
const ROLE_PERM = { manager: 'owner', member: 'edit', reader: 'view' };
const isTeam = ownerId => { const u = getUser(ownerId); return !!u && u.kind === 'team'; };
const teamRole = (teamId, userId) => db.prepare('SELECT role FROM team_members WHERE team_id=? AND user_id=?').get(teamId, userId)?.role || null;
const myTeams = userId => db.prepare(`SELECT u.id, u.name, u.quota, m.role FROM team_members m JOIN users u ON u.id=m.team_id
  WHERE m.user_id=? AND u.kind='team' ORDER BY u.name COLLATE NOCASE`).all(userId);
const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'];

function log(itemId, user, action, detail) {
  db.prepare('INSERT INTO activity(item_id,user_id,user_name,action,detail,at) VALUES(?,?,?,?,?,?)')
    .run(itemId, user ? user.id : null, user ? user.name : 'Invité', action, detail || null, now());
}

function cleanName(n) {
  n = String(n || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!n || n === '.' || n === '..') throw E(400, 'Nom invalide');
  return n;
}
function siblings(parentId, ownerId) {
  return parentId
    ? db.prepare('SELECT id,name,type FROM items WHERE parent_id=? AND trashed_at IS NULL').all(parentId)
    : db.prepare('SELECT id,name,type FROM items WHERE parent_id IS NULL AND owner_id=? AND trashed_at IS NULL').all(ownerId);
}
function uniqueName(parentId, ownerId, name, exceptId) {
  const s = new Set(siblings(parentId, ownerId).filter(x => x.id !== exceptId).map(x => x.name.toLowerCase()));
  if (!s.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let i = 1; while (s.has(`${base} (${i})${ext}`.toLowerCase())) i++;
  return `${base} (${i})${ext}`;
}

/* --- Droits : owner > edit > view --- */
function perm(user, item) {
  if (!item || !user || !user.id) return null;
  if (item.owner_id === user.id) return 'owner';
  let best = null;
  if (isTeam(item.owner_id)) { const r = teamRole(item.owner_id, user.id); if (r === 'manager') return 'owner'; best = ROLE_PERM[r] || null; }
  if (best === 'edit') return best;
  const ids = ancestors(item.id).map(a => a.id);
  const rows = db.prepare(`SELECT perm FROM access WHERE user_id=? AND item_id IN (${ids.map(() => '?').join(',')})`).all(user.id, ...ids);
  if (rows.some(r => r.perm === 'edit')) return 'edit';
  if (rows.length) return 'view';
  return best;
}
const canEdit = p => p === 'owner' || p === 'edit';
function need(user, id, level = 'view') {
  const it = getItem(id);
  if (!it) throw E(404, 'Élément introuvable');
  const p = perm(user, it);
  if (!p) throw E(404, 'Élément introuvable');
  if (level === 'edit' && !canEdit(p)) throw E(403, 'Droits insuffisants');
  if (level === 'owner' && p !== 'owner') throw E(403, 'Seul le propriétaire peut faire cela');
  return Object.assign(it, { perm: p });
}

/* --- Quota --- */
const usedStmt = db.prepare(`SELECT
  COALESCE((SELECT SUM(size) FROM items WHERE owner_id=?), 0) +
  COALESCE((SELECT SUM(v.size) FROM versions v JOIN items i ON i.id=v.item_id WHERE i.owner_id=?), 0) AS u`);
const used = o => usedStmt.get(o, o).u;
function checkQuota(ownerId, add) {
  const u = getUser(ownerId);
  if (u && u.quota > 0 && used(ownerId) + add > u.quota) throw E(413, 'Quota de stockage dépassé');
}

/* --- Création / stockage --- */
function createItem({ owner, parent, type, name, size = 0, mimeType = null, by }) {
  const id = uid(), t = now();
  const n = uniqueName(parent, owner, cleanName(name));
  db.prepare(`INSERT INTO items(id,owner_id,parent_id,type,name,size,mime,version,created,modified,modified_by)
    VALUES(?,?,?,?,?,?,?,1,?,?,?)`).run(id, owner, parent || null, type, n, size, mimeType, t, t, by || null);
  return getItem(id);
}
function moveFile(src, dst) {
  try { fs.renameSync(src, dst); } catch (e) { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }); }
}
function resolveParent(user, parentId) {
  if (!parentId || parentId === 'root') return { owner: user.id, parent: null };
  if (String(parentId).startsWith('team:')) {
    const tid = String(parentId).slice(5), r = teamRole(tid, user.id);
    if (!r || !isTeam(tid)) throw E(404, 'Espace introuvable');
    if (!canEdit(ROLE_PERM[r])) throw E(403, 'Vous êtes en lecture seule dans cet espace');
    return { owner: tid, parent: null };
  }
  const f = need(user, parentId, 'edit');
  if (f.type !== 'folder' || f.trashed_at) throw E(400, 'Dossier de destination invalide');
  return { owner: f.owner_id, parent: f.id };
}
function ensureFolderPath(parent, owner, segs, user) {
  let p = parent;
  for (const raw of segs) {
    const name = cleanName(raw);
    const ex = siblings(p, owner).find(s => s.type === 'folder' && s.name.toLowerCase() === name.toLowerCase());
    p = ex ? ex.id : createItem({ owner, parent: p, type: 'folder', name, by: user && user.name }).id;
  }
  return p;
}
function storeUploads(files, paths, owner, parent, user) {
  const total = files.reduce((s, f) => s + f.size, 0);
  try { checkQuota(owner, total); } catch (e) { files.forEach(f => fs.rmSync(f.path, { force: true })); throw e; }
  const list = Array.isArray(paths) ? paths : paths != null ? [paths] : [];
  return files.map((f, i) => {
    const rel = list[i] || Buffer.from(f.originalname, 'latin1').toString('utf8');
    const segs = rel.split('/').map(s => s.trim()).filter(Boolean);
    const fname = segs.pop() || 'fichier';
    const p = segs.length ? ensureFolderPath(parent, owner, segs, user) : parent;
    const type = (f.mimetype && f.mimetype !== 'application/octet-stream') ? f.mimetype : (mime.lookup(fname) || 'application/octet-stream');
    const it = createItem({ owner, parent: p, type: 'file', name: fname, size: f.size, mimeType: type, by: user ? user.name : 'Invité' });
    moveFile(f.path, fpath(it.id));
    log(it.id, user && user.id !== undefined ? user : null, 'upload');
    indexer.enqueue(it.id);
    return it;
  });
}
// data : Buffer ou chemin d'un fichier temporaire (déplacé)
function saveNewVersion(item, data, authorName, newExt) {
  const vid = uid();
  // Un fichier vide (créé puis rempli par WebDAV, par ex.) ne mérite pas de version
  if (fs.existsSync(fpath(item.id)) && item.size > 0) {
    fs.copyFileSync(fpath(item.id), vpath(vid));
    db.prepare('INSERT INTO versions(id,item_id,version,size,created,author) VALUES(?,?,?,?,?,?)')
      .run(vid, item.id, item.version, item.size, item.modified, item.modified_by);
  }
  let size;
  if (Buffer.isBuffer(data)) { fs.writeFileSync(fpath(item.id), data); size = data.length; }
  else { size = fs.statSync(data).size; moveFile(data, fpath(item.id)); }
  let name = item.name;
  if (newExt && newExt !== EXT(name)) name = uniqueName(item.parent_id, item.owner_id, name.replace(/\.[^.]+$/, '') + '.' + newExt, item.id);
  db.prepare('UPDATE items SET size=?, version=version+1, modified=?, modified_by=?, name=? WHERE id=?')
    .run(size, now(), authorName, name, item.id);
  markDirty(item.id);
  // Limite du nombre de versions conservées
  const old = db.prepare('SELECT id FROM versions WHERE item_id=? ORDER BY version DESC LIMIT -1 OFFSET ?').all(item.id, C.MAX_VERSIONS);
  for (const v of old) { fs.rmSync(vpath(v.id), { force: true }); db.prepare('DELETE FROM versions WHERE id=?').run(v.id); }
  return getItem(item.id);
}

/* --- Corbeille --- */
function trashItem(it) {
  const t = now();
  const st = db.prepare('UPDATE items SET trashed_at=?, trash_root=? WHERE id=?');
  db.transaction(() => {
    for (const d of descendants(it.id)) if (d.id === it.id || !d.trashed_at) st.run(t, d.id === it.id ? 1 : 0, d.id);
  })();
}
function restoreItem(it) {
  let parent = it.parent_id;
  const p = getItem(parent);
  if (parent && (!p || p.trashed_at)) parent = null;
  db.transaction(() => {
    for (const d of descendants(it.id)) if (d.trashed_at === it.trashed_at) db.prepare('UPDATE items SET trashed_at=NULL, trash_root=0 WHERE id=?').run(d.id);
    db.prepare('UPDATE items SET parent_id=?, name=? WHERE id=?').run(parent, uniqueName(parent, it.owner_id, it.name, it.id), it.id);
  })();
}
function purgeItem(it) {
  for (const d of descendants(it.id)) {
    fs.rmSync(fpath(d.id), { force: true });
    indexer.remove(d.id);
    for (const v of db.prepare('SELECT id FROM versions WHERE item_id=?').all(d.id)) fs.rmSync(vpath(v.id), { force: true });
  }
  db.prepare('DELETE FROM items WHERE id=?').run(it.id);
}

/* --- Copie récursive --- */
function copyTree(it, parent, owner, user, rename, forcedName) {
  const name = forcedName || (rename ? (() => { const d = it.name.lastIndexOf('.'); return it.type === 'file' && d > 0 ? it.name.slice(0, d) + ' - copie' + it.name.slice(d) : it.name + ' - copie'; })() : it.name);
  const n = createItem({ owner, parent, type: it.type, name, size: it.size, mimeType: it.mime, by: user.name });
  if (it.color) db.prepare('UPDATE items SET color=? WHERE id=?').run(it.color, n.id);
  if (it.type === 'file') { if (fs.existsSync(fpath(it.id))) fs.copyFileSync(fpath(it.id), fpath(n.id)); indexer.enqueue(n.id); }
  else for (const c of db.prepare('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL').all(it.id)) copyTree(c, n.id, owner, user, false);
  return n;
}

/* --- Déplacement (y compris entre espaces) --- */
function moveItem(user, it, dest, newName) {
  if (dest.parent && (dest.parent === it.id || ancestors(dest.parent).some(a => a.id === it.id))) throw E(400, 'Impossible de déplacer un dossier dans lui-même');
  const name = newName ? cleanName(newName) : it.name;
  if (it.owner_id !== dest.owner) {
    if (perm(user, it) !== 'owner') throw E(403, `Seul le propriétaire peut déplacer « ${it.name} » vers un autre espace (utilisez Copier)`);
    const desc = descendants(it.id);
    checkQuota(dest.owner, desc.reduce((s, d) => s + d.size, 0));
    const st = db.prepare('UPDATE items SET owner_id=? WHERE id=?');
    db.transaction(() => desc.forEach(d => st.run(dest.owner, d.id)))();
  }
  const finalName = uniqueName(dest.parent, dest.owner, name, it.id);
  db.prepare('UPDATE items SET parent_id=?, name=?, modified=? WHERE id=?').run(dest.parent, finalName, now(), it.id);
  if (finalName !== it.name) indexer.rename(it.id, finalName);
  return getItem(it.id);
}

/* --- Sérialisation --- */
const LIST = w => `SELECT i.*, u.name AS owner_name, u.kind AS owner_kind,
  EXISTS(SELECT 1 FROM stars s WHERE s.item_id=i.id AND s.user_id=@uid) AS starred,
  (EXISTS(SELECT 1 FROM links l WHERE l.item_id=i.id) OR EXISTS(SELECT 1 FROM access a WHERE a.item_id=i.id)) AS shared,
  (SELECT COUNT(*) FROM items c WHERE c.parent_id=i.id AND c.trashed_at IS NULL) AS children,
  (SELECT COUNT(*) FROM comments k WHERE k.item_id=i.id) AS comments
  FROM items i JOIN users u ON u.id=i.owner_id WHERE ${w}`;
function ser(it, user, extra = {}) {
  return {
    id: it.id, name: it.name, type: it.type, size: it.size, mime: it.mime, ext: it.type === 'file' ? EXT(it.name) : '',
    version: it.version, description: it.description || '', starred: !!it.starred, shared: !!it.shared, color: it.color || null,
    children: it.children || 0, comments: it.comments || 0, created: it.created, modified: it.modified, modified_by: it.modified_by,
    trashed_at: it.trashed_at, owner_name: it.owner_name, owner_id: it.owner_id, team: it.owner_kind === 'team', mine: user ? it.owner_id === user.id : false, parent_id: it.parent_id,
    ...extra,
  };
}
// Chemin visible pour l'utilisateur : son espace, un espace d'équipe, ou à partir du dossier partagé
function visiblePath(user, itemId, includeSelf = true) {
  const all = ancestors(itemId);
  let anc = includeSelf ? all : all.slice(0, -1);
  const top = all[0];
  if (!top) return { root: 'drive', path: [] };
  const P = a => ({ id: a.id, name: a.name });
  if (top.owner_id === user.id) return { root: 'drive', path: anc.map(P) };
  if (isTeam(top.owner_id) && teamRole(top.owner_id, user.id)) {
    const t = getUser(top.owner_id);
    return { root: 'team', team: { id: t.id, name: t.name, role: teamRole(t.id, user.id) }, path: anc.map(P) };
  }
  const ids = new Set(db.prepare('SELECT item_id FROM access WHERE user_id=?').all(user.id).map(r => r.item_id));
  const k = anc.findIndex(a => ids.has(a.id));
  return { root: 'shared', path: (k < 0 ? [] : anc.slice(k)).map(P) };
}
const rootLabel = vp => (vp.root === 'drive' ? 'Mon espace' : vp.root === 'team' ? vp.team.name : 'Partagés avec moi');
function withLocation(user, rows, extraFn) {
  return rows.map(r => {
    const vp = visiblePath(user, r.id, false);
    return ser(r, user, { location: [rootLabel(vp), ...vp.path.map(p => p.name)].join(' / '), perm: perm(user, r), ...(extraFn ? extraFn(r) : {}) });
  });
}

/* --- Envoi de fichiers --- */
const DANGEROUS = /html|svg|xml|javascript|ecmascript/i;
function sendRaw(res, file, name, mimeType, download) {
  if (!fs.existsSync(file)) throw E(404, 'Fichier absent du stockage');
  let type = mimeType || mime.lookup(name) || 'application/octet-stream';
  if (!download && DANGEROUS.test(type)) type = 'text/plain; charset=utf-8';
  else if (/^text\//.test(type) && !/charset/.test(type)) type += '; charset=utf-8';
  const headers = {
    'Content-Type': type,
    'Content-Disposition': contentDisposition(name, { type: download ? 'attachment' : 'inline' }),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0, must-revalidate',
  };
  if (!/pdf/.test(type)) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
  res.sendFile(file, { headers, dotfiles: 'allow' });
}
function zipTo(res, roots, filename) {
  res.attachment(filename);
  const z = archiver('zip', { zlib: { level: 5 } });
  z.on('error', e => res.destroy(e));
  z.pipe(res);
  const add = (it, prefix) => {
    if (it.trashed_at) return;
    if (it.type === 'file') { if (fs.existsSync(fpath(it.id))) z.file(fpath(it.id), { name: prefix + it.name }); return; }
    const kids = db.prepare('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL').all(it.id);
    if (!kids.length) z.append(Buffer.alloc(0), { name: prefix + it.name + '/' });
    kids.forEach(c => add(c, prefix + it.name + '/'));
  };
  roots.forEach(r => add(r, ''));
  z.finalize();
}

/* ============================== Application ============================== */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Frame-Options', 'SAMEORIGIN'); res.set('Referrer-Policy', 'same-origin'); next(); });

/* --- Anti force brute --- */
const attempts = new Map();
function throttle(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > now()) throw E(429, 'Trop de tentatives, réessayez dans quelques minutes');
  return a;
}
function failed(key, a) { a.n++; if (a.n >= 8) { a.until = now() + 10 * 60e3; a.n = 0; } attempts.set(key, a); }
setInterval(() => { const t = now(); for (const [k, a] of attempts) if (a.until < t && a.n === 0) attempts.delete(k); }, 3600e3).unref();

/* --- Mots de passe d'application (WebDAV, clients tiers) --- */
function checkAppPassword(user, pw) {
  pw = String(pw || '').trim().toLowerCase();
  for (const r of db.prepare('SELECT * FROM app_passwords WHERE user_id=?').all(user.id)) {
    if (bcrypt.compareSync(pw, r.hash)) { db.prepare('UPDATE app_passwords SET last_used=? WHERE id=?').run(now(), r.id); return true; }
  }
  return false;
}

/* --- WebDAV (monté avant les parseurs JSON : le corps des requêtes est lu en flux) --- */
mountDav(app, {
  db, C, E, DATA, getUser, getItem, perm, canEdit, myTeams, ROLE_PERM, siblings, cleanName, createItem, saveNewVersion,
  trashItem, moveItem, copyTree, checkQuota, used, fpath, uid, now, log, indexer, mime, bcrypt, throttle, failed, descendants,
  checkAppPassword, isTeam,
});

app.use(cookieParser());
app.use(express.json({ limit: '20mb' }));

// Protection CSRF : toute requête API modifiante doit porter l'en-tête X-ED
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-ED') !== '1') return res.status(403).json({ error: 'Requête refusée' });
  next();
});

/* --- Session --- */
const COOKIE = 'ed_sess';
function setSession(res, user) {
  res.cookie(COOKIE, jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: 30 * 864e5 });
}
function currentUser(req) {
  try {
    const p = jwt.verify(req.cookies[COOKIE], SECRET);
    const u = getUser(p.uid);
    return u && !u.disabled && u.kind === 'user' ? u : null;
  } catch (e) { return null; }
}
const auth = (req, res, next) => { const u = currentUser(req); if (!u) return res.status(401).json({ error: 'Session expirée, reconnectez-vous' }); req.user = u; next(); };
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Réservé aux administrateurs' }));
const pubUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, quota: u.quota, disabled: !!u.disabled, created: u.created, last_login: u.last_login, totp: !!u.totp_secret });
const userCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE kind='user'").get().c;
const signupOpen = () => userCount() === 0 || setting('allow_signup', process.env.ALLOW_SIGNUP === 'true' ? '1' : '0') === '1';
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

app.get('/api/config', (req, res) => {
  res.json({ appName: C.APP_NAME, signup: signupOpen(), firstRun: userCount() === 0, onlyoffice: ooEnabled() });
});

app.post('/api/login', h(async (req, res) => {
  const key = req.ip + '|' + String(req.body.email || '').toLowerCase();
  const a = throttle(key);
  const u = db.prepare("SELECT * FROM users WHERE email=? AND kind='user'").get(String(req.body.email || '').trim());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password)) { failed(key, a); throw E(401, 'Adresse e-mail ou mot de passe incorrect'); }
  if (u.disabled) throw E(403, 'Ce compte est désactivé');
  attempts.delete(key);
  if (u.totp_secret) return res.json({ need2fa: true, ticket: jwt.sign({ uid: u.id, k: '2fa' }, SECRET, { expiresIn: '5m' }) });
  db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now(), u.id);
  setSession(res, u);
  res.json({ ok: true });
}));
app.post('/api/login/2fa', h(async (req, res) => {
  let p; try { p = jwt.verify(String(req.body.ticket || ''), SECRET); } catch (e) { throw E(401, 'Délai dépassé, reconnectez-vous'); }
  if (p.k !== '2fa') throw E(401, 'Jeton invalide');
  const key = '2fa|' + p.uid, a = throttle(key);
  const u = getUser(p.uid);
  if (!u || u.disabled || !u.totp_secret) throw E(401, 'Compte invalide');
  const code = String(req.body.code || '').trim();
  let ok = totp.verify(u.totp_secret, code);
  if (!ok && /[a-z0-9]{4}-?[a-z0-9]{4}/i.test(code)) {
    const list = JSON.parse(u.recovery || '[]'), hsh = sha(code.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (list.includes(hsh)) { ok = true; db.prepare('UPDATE users SET recovery=? WHERE id=?').run(JSON.stringify(list.filter(x => x !== hsh)), u.id); }
  }
  if (!ok) { failed(key, a); throw E(401, 'Code incorrect'); }
  attempts.delete(key);
  db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now(), u.id);
  setSession(res, u);
  res.json({ ok: true });
}));
app.post('/api/register', h(async (req, res) => {
  const first = userCount() === 0;
  if (!signupOpen()) throw E(403, 'Les inscriptions sont fermées');
  const email = String(req.body.email || '').trim().toLowerCase(), name = String(req.body.name || '').trim().slice(0, 80), pw = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw E(400, 'Adresse e-mail invalide');
  if (!name) throw E(400, 'Le nom est obligatoire');
  if (pw.length < 8) throw E(400, 'Le mot de passe doit contenir au moins 8 caractères');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw E(409, 'Un compte existe déjà avec cette adresse');
  const u = { id: uid(), email, name, password: bcrypt.hashSync(pw, 10), role: first ? 'admin' : 'user', quota: first ? 0 : C.DEFAULT_QUOTA, created: now() };
  db.prepare('INSERT INTO users(id,email,name,password,role,quota,created) VALUES(@id,@email,@name,@password,@role,@quota,@created)').run(u);
  setSession(res, u);
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

/* ============================== API authentifiée ============================== */
const api = express.Router();
api.use(auth);

api.get('/me', (req, res) => {
  const u = req.user;
  const byType = db.prepare(`SELECT mime, name, size FROM items WHERE owner_id=? AND type='file'`).all(u.id);
  const cat = { documents: 0, images: 0, videos: 0, audio: 0, archives: 0, autres: 0 };
  for (const f of byType) {
    const m = f.mime || '', e = EXT(f.name);
    if (m.startsWith('image/')) cat.images += f.size;
    else if (m.startsWith('video/')) cat.videos += f.size;
    else if (m.startsWith('audio/')) cat.audio += f.size;
    else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) cat.archives += f.size;
    else if (docType(e) || m.startsWith('text/')) cat.documents += f.size;
    else cat.autres += f.size;
  }
  const versions = used(u.id) - byType.reduce((s, f) => s + f.size, 0);
  res.json({
    user: pubUser(u), used: used(u.id), quota: u.quota, breakdown: { ...cat, versions },
    appName: C.APP_NAME, appUrl: C.APP_URL, onlyoffice: ooEnabled() ? { edit: OO_EDIT, view: Object.values(OO_TYPES).flat() } : null,
    trashDays: C.TRASH_DAYS, teams: myTeams(u.id).map(t => ({ ...t, used: used(t.id) })),
  });
});
api.patch('/me', h(async (req, res) => {
  const u = req.user;
  if (req.body.name != null) { const n = String(req.body.name).trim().slice(0, 80); if (!n) throw E(400, 'Nom invalide'); db.prepare('UPDATE users SET name=? WHERE id=?').run(n, u.id); }
  if (req.body.password) {
    if (!bcrypt.compareSync(String(req.body.current || ''), u.password)) throw E(400, 'Mot de passe actuel incorrect');
    if (String(req.body.password).length < 8) throw E(400, 'Le nouveau mot de passe doit contenir au moins 8 caractères');
    db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(String(req.body.password), 10), u.id);
  }
  res.json({ ok: true });
}));

/* --- Double authentification (TOTP) --- */
api.post('/me/2fa/setup', h(async (req, res) => {
  if (req.user.totp_secret) throw E(400, 'La double authentification est déjà activée');
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_pending=? WHERE id=?').run(secret, req.user.id);
  const uri = totp.uri(secret, req.user.email, C.APP_NAME);
  res.json({ secret, uri, qr: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 }) });
}));
api.post('/me/2fa/enable', h(async (req, res) => {
  const u = getUser(req.user.id);
  if (!u.totp_pending) throw E(400, "Commencez par scanner le QR code");
  if (!totp.verify(u.totp_pending, req.body.code)) throw E(400, 'Code incorrect — vérifiez l\'heure de votre téléphone');
  const codes = Array.from({ length: 8 }, () => { const s = crypto.randomBytes(5).toString('hex').slice(0, 8); return s.slice(0, 4) + '-' + s.slice(4); });
  db.prepare('UPDATE users SET totp_secret=?, totp_pending=NULL, recovery=? WHERE id=?').run(u.totp_pending, JSON.stringify(codes.map(c => sha(c.replace('-', '')))), u.id);
  res.json({ codes });
}));
api.post('/me/2fa/disable', h(async (req, res) => {
  const u = req.user;
  if (!bcrypt.compareSync(String(req.body.password || ''), u.password)) throw E(400, 'Mot de passe incorrect');
  db.prepare('UPDATE users SET totp_secret=NULL, totp_pending=NULL, recovery=NULL WHERE id=?').run(u.id);
  res.json({ ok: true });
}));

/* --- Mots de passe d'application --- */
api.get('/me/app-passwords', (req, res) => {
  res.json({ davUrl: C.APP_URL + '/dav/', items: db.prepare('SELECT id, name, created, last_used FROM app_passwords WHERE user_id=? ORDER BY created DESC').all(req.user.id) });
});
api.post('/me/app-passwords', h(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60) || 'Appareil';
  const raw = crypto.randomBytes(12).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(16, 'x').slice(0, 16);
  const pw = raw.match(/.{4}/g).join('-');
  db.prepare('INSERT INTO app_passwords(id,user_id,name,hash,created) VALUES(?,?,?,?,?)').run(uid(), req.user.id, name, bcrypt.hashSync(pw, 10), now());
  res.json({ password: pw, login: req.user.email, davUrl: C.APP_URL + '/dav/' });
}));
api.delete('/me/app-passwords/:id', (req, res) => {
  db.prepare('DELETE FROM app_passwords WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

/* --- Listes --- */
api.get('/folder/:id', h(async (req, res) => {
  const u = req.user, id = req.params.id;
  let folder = null, p = 'owner', rows, vp;
  if (id === 'root') {
    rows = db.prepare(LIST('i.parent_id IS NULL AND i.owner_id=@uid AND i.trashed_at IS NULL')).all({ uid: u.id });
    vp = { root: 'drive', path: [] };
  } else if (id.startsWith('team:')) {
    const tid = id.slice(5), role = teamRole(tid, u.id);
    if (!role || !isTeam(tid)) throw E(404, 'Espace introuvable');
    const t = getUser(tid);
    p = ROLE_PERM[role];
    rows = db.prepare(LIST('i.parent_id IS NULL AND i.owner_id=@tid AND i.trashed_at IS NULL')).all({ uid: u.id, tid });
    vp = { root: 'team', team: { id: t.id, name: t.name, role, quota: t.quota, used: used(t.id) }, path: [] };
  } else {
    folder = need(u, id);
    if (folder.type !== 'folder') throw E(400, "Ce n'est pas un dossier");
    if (folder.trashed_at) throw E(404, 'Ce dossier est dans la corbeille');
    p = folder.perm;
    rows = db.prepare(LIST('i.parent_id=@pid AND i.trashed_at IS NULL')).all({ uid: u.id, pid: folder.id });
    vp = visiblePath(u, folder.id);
  }
  res.json({ folder: folder ? ser(folder, u) : null, perm: p, root: vp.root, team: vp.team || null, path: vp.path, items: rows.map(r => ser(r, u, { perm: r.owner_id === u.id ? 'owner' : p })) });
}));
const writableOwners = `(i.owner_id=@uid OR i.owner_id IN (SELECT team_id FROM team_members WHERE user_id=@uid AND role IN ('manager','member')))`;
api.get('/view/:view', h(async (req, res) => {
  const u = req.user, v = req.params.view, P = { uid: u.id, uname: u.name };
  let rows;
  if (v === 'recent') rows = withLocation(u, db.prepare(LIST(`i.type='file' AND i.trashed_at IS NULL AND (${writableOwners} OR i.modified_by=@uname OR i.owner_id IN (SELECT team_id FROM team_members WHERE user_id=@uid))`) + ' ORDER BY i.modified DESC LIMIT 80').all(P).filter(r => perm(u, r)).slice(0, 60));
  else if (v === 'starred') rows = withLocation(u, db.prepare(LIST('i.trashed_at IS NULL AND EXISTS(SELECT 1 FROM stars s WHERE s.item_id=i.id AND s.user_id=@uid)')).all(P).filter(r => perm(u, r)));
  else if (v === 'shared') rows = db.prepare(LIST('i.trashed_at IS NULL AND i.id IN (SELECT item_id FROM access WHERE user_id=@uid)')).all(P).map(r => ser(r, u, { location: 'Partagé par ' + r.owner_name, perm: perm(u, r) }));
  else if (v === 'links') rows = withLocation(u, db.prepare(LIST(`${writableOwners} AND i.trashed_at IS NULL AND (EXISTS(SELECT 1 FROM links l WHERE l.item_id=i.id) OR EXISTS(SELECT 1 FROM access a WHERE a.item_id=i.id))`)).all(P).filter(r => perm(u, r) === 'owner'));
  else if (v === 'trash') rows = withLocation(u, db.prepare(LIST(`${writableOwners} AND i.trash_root=1 AND i.trashed_at IS NOT NULL`)).all(P));
  else throw E(404, 'Vue inconnue');
  res.json({ items: rows });
}));
api.get('/search', h(async (req, res) => {
  const u = req.user, q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const m = indexer.match(q);
  const snippets = new Map();
  if (m) {
    try {
      for (const r of db.prepare(`SELECT item_id, snippet(fts, 2, char(1), char(2), '…', 14) AS s, bm25(fts) AS score FROM fts WHERE fts MATCH ? ORDER BY score LIMIT 500`).all(m)) snippets.set(r.item_id, r.s);
    } catch (e) { /* requête FTS invalide : on garde la recherche par nom */ }
  }
  const ids = [...snippets.keys()];
  const rows = db.prepare(LIST(`i.trashed_at IS NULL AND (i.name LIKE @q ESCAPE '\\' OR i.description LIKE @q ESCAPE '\\' ${ids.length ? `OR i.id IN (SELECT value FROM json_each(@ids))` : ''})`) + ' LIMIT 1500')
    .all({ uid: u.id, q: like, ids: JSON.stringify(ids) });
  const visible = rows.filter(r => perm(u, r)).slice(0, 300);
  // Les correspondances de nom d'abord, puis celles du contenu
  const nameHit = r => r.name.toLowerCase().includes(q.toLowerCase());
  visible.sort((a, b) => (nameHit(b) - nameHit(a)) || (b.modified - a.modified));
  res.json({ items: withLocation(u, visible, r => { const s = snippets.get(r.id); return s && /\u0001/.test(s) ? { snippet: s.replace(/\s+/g, ' ') } : {}; }) });
}));

/* --- Détails --- */
api.get('/items/:id', h(async (req, res) => {
  const u = req.user, it = need(u, req.params.id);
  const row = db.prepare(LIST('i.id=@id')).get({ uid: u.id, id: it.id });
  const size = it.type === 'folder' ? descendants(it.id).filter(d => !d.trashed_at && d.type === 'file').reduce((s, d) => s + d.size, 0) : it.size;
  const count = it.type === 'folder' ? descendants(it.id).filter(d => !d.trashed_at).length - 1 : 0;
  const vp = visiblePath(u, it.id, false);
  res.json(ser(row, u, { perm: it.perm, totalSize: size, count, location: [rootLabel(vp), ...vp.path.map(p => p.name)].join(' / ') }));
}));
api.get('/items/:id/activity', h(async (req, res) => {
  const it = need(req.user, req.params.id);
  res.json(db.prepare('SELECT user_name, action, detail, at FROM activity WHERE item_id=? ORDER BY at DESC LIMIT 50').all(it.id));
}));

/* --- Commentaires --- */
api.get('/items/:id/comments', h(async (req, res) => {
  const it = need(req.user, req.params.id);
  res.json(db.prepare('SELECT id, user_id, user_name, text, created FROM comments WHERE item_id=? ORDER BY created').all(it.id)
    .map(c => ({ ...c, mine: c.user_id === req.user.id, canDelete: c.user_id === req.user.id || it.perm === 'owner' })));
}));
api.post('/items/:id/comments', h(async (req, res) => {
  const it = need(req.user, req.params.id);
  const text = String(req.body.text || '').trim().slice(0, 4000);
  if (!text) throw E(400, 'Commentaire vide');
  db.prepare('INSERT INTO comments(id,item_id,user_id,user_name,text,created) VALUES(?,?,?,?,?,?)').run(uid(), it.id, req.user.id, req.user.name, text, now());
  log(it.id, req.user, 'comment');
  res.json({ ok: true });
}));
api.delete('/comments/:cid', h(async (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(req.params.cid);
  if (!c) throw E(404, 'Commentaire introuvable');
  const it = need(req.user, c.item_id);
  if (c.user_id !== req.user.id && it.perm !== 'owner') throw E(403, 'Droits insuffisants');
  db.prepare('DELETE FROM comments WHERE id=?').run(c.id);
  res.json({ ok: true });
}));

/* --- Création --- */
api.post('/folders', h(async (req, res) => {
  const { owner, parent } = resolveParent(req.user, req.body.parent);
  const it = createItem({ owner, parent, type: 'folder', name: req.body.name || 'Nouveau dossier', by: req.user.name });
  log(it.id, req.user, 'create');
  res.json(ser(it, req.user));
}));
const TEMPLATES = { docx: 'blank.docx', xlsx: 'blank.xlsx', pptx: 'blank.pptx' };
api.post('/new', h(async (req, res) => {
  const kind = String(req.body.kind || 'txt');
  const { owner, parent } = resolveParent(req.user, req.body.parent);
  let buf;
  if (TEMPLATES[kind]) buf = fs.readFileSync(path.join(__dirname, '..', 'templates', TEMPLATES[kind]));
  else if (['txt', 'md', 'csv'].includes(kind)) buf = Buffer.from(String(req.body.content || ''), 'utf8');
  else throw E(400, 'Type de document inconnu');
  checkQuota(owner, buf.length);
  let name = cleanName(req.body.name || 'Sans titre');
  if (EXT(name) !== kind) name += '.' + kind;
  const it = createItem({ owner, parent, type: 'file', name, size: buf.length, mimeType: mime.lookup(name) || 'application/octet-stream', by: req.user.name });
  fs.writeFileSync(fpath(it.id), buf);
  log(it.id, req.user, 'create');
  indexer.enqueue(it.id);
  res.json(ser(it, req.user));
}));
const upload = multer({ dest: path.join(DATA, 'tmp'), limits: { fileSize: C.MAX_UPLOAD, files: 1000 } });
api.post('/upload', upload.array('files'), h(async (req, res) => {
  let target;
  try { target = resolveParent(req.user, req.query.parent || req.body.parent); }
  catch (e) { (req.files || []).forEach(f => fs.rmSync(f.path, { force: true })); throw e; }
  const items = storeUploads(req.files || [], req.body.paths, target.owner, target.parent, req.user);
  res.json({ items: items.map(i => ser(i, req.user)) });
}));

/* --- Extraction d'une archive zip --- */
const MAX_ZIP = 2 * 1024 ** 3;
api.post('/items/:id/extract', h(async (req, res) => {
  const u = req.user, z = need(u, req.params.id);
  if (z.type !== 'file' || EXT(z.name) !== 'zip') throw E(400, "Seules les archives .zip peuvent être extraites");
  if (z.size > MAX_ZIP) throw E(413, 'Archive trop volumineuse pour être extraite sur le serveur (2 Go max)');
  const target = z.parent_id && canEdit(perm(u, getItem(z.parent_id))) ? { owner: z.owner_id, parent: z.parent_id }
    : !z.parent_id && canEdit(z.perm) ? { owner: z.owner_id, parent: null } : { owner: u.id, parent: null };
  let zip;
  try { zip = new AdmZip(fpath(z.id)); } catch (e) { throw E(400, 'Archive illisible ou corrompue'); }
  const entries = zip.getEntries().filter(e => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(e.entryName));
  if (entries.length > 20000) throw E(400, 'Archive trop volumineuse (plus de 20 000 éléments)');
  if (entries.some(e => e.header.encripted)) throw E(400, 'Les archives protégées par mot de passe ne sont pas prises en charge');
  const total = entries.reduce((s, e) => s + (e.isDirectory ? 0 : e.header.size), 0);
  checkQuota(target.owner, total);
  const root = createItem({ owner: target.owner, parent: target.parent, type: 'folder', name: z.name.replace(/\.zip$/i, ''), by: u.name });
  const folders = new Map([['', root.id]]);
  const dirOf = segs => {
    let key = '', p = root.id;
    for (const s of segs) {
      key += '/' + s;
      if (!folders.has(key)) folders.set(key, createItem({ owner: target.owner, parent: p, type: 'folder', name: s, by: u.name }).id);
      p = folders.get(key);
    }
    return p;
  };
  let n = 0;
  for (const e of entries) {
    const segs = e.entryName.replace(/\\/g, '/').split('/').map(s => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim()).filter(s => s && s !== '.' && s !== '..');
    if (!segs.length) continue;
    if (e.isDirectory) { dirOf(segs); continue; }
    const name = segs.pop();
    const parent = dirOf(segs);
    const data = e.getData();
    const it = createItem({ owner: target.owner, parent, type: 'file', name, size: data.length, mimeType: mime.lookup(name) || 'application/octet-stream', by: u.name });
    fs.writeFileSync(fpath(it.id), data);
    indexer.enqueue(it.id);
    n++;
    if (n % 200 === 0) await new Promise(r => setImmediate(r));
  }
  log(root.id, u, 'extract', z.name);
  res.json({ folder: ser(root, u), count: n });
}));

/* --- Modification --- */
api.patch('/items/:id', h(async (req, res) => {
  const u = req.user;
  const onlyStar = req.body.starred != null && Object.keys(req.body).length === 1;
  const it = need(u, req.params.id, onlyStar ? 'view' : 'edit');
  if (req.body.name != null) {
    const n = cleanName(req.body.name);
    if (siblings(it.parent_id, it.owner_id).some(s => s.id !== it.id && s.name.toLowerCase() === n.toLowerCase())) throw E(409, 'Un élément porte déjà ce nom à cet emplacement');
    db.prepare('UPDATE items SET name=?, modified=? WHERE id=?').run(n, now(), it.id);
    indexer.rename(it.id, n);
    log(it.id, u, 'rename', `${it.name} → ${n}`);
  }
  if (req.body.description != null) db.prepare('UPDATE items SET description=? WHERE id=?').run(String(req.body.description).slice(0, 2000), it.id);
  if (req.body.color !== undefined) db.prepare('UPDATE items SET color=? WHERE id=?').run(COLORS.includes(req.body.color) ? req.body.color : null, it.id);
  if (req.body.starred != null) {
    if (req.body.starred) db.prepare('INSERT OR IGNORE INTO stars(user_id,item_id) VALUES(?,?)').run(u.id, it.id);
    else db.prepare('DELETE FROM stars WHERE user_id=? AND item_id=?').run(u.id, it.id);
  }
  res.json(ser(db.prepare(LIST('i.id=@id')).get({ uid: u.id, id: it.id }), u));
}));
api.put('/items/:id/content', express.raw({ type: '*/*', limit: '50mb' }), h(async (req, res) => {
  const it = need(req.user, req.params.id, 'edit');
  if (it.type !== 'file') throw E(400, 'Pas un fichier');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  checkQuota(it.owner_id, buf.length);
  const n = saveNewVersion(it, buf, req.user.name);
  log(it.id, req.user, 'edit');
  res.json(ser(n, req.user));
}));
api.post('/move', h(async (req, res) => {
  const u = req.user, ids = [].concat(req.body.ids || []);
  const dest = resolveParent(u, req.body.target || 'root');
  const destName = dest.parent ? getItem(dest.parent).name : String(req.body.target || '').startsWith('team:') ? getUser(dest.owner).name : 'Mon espace';
  let n = 0;
  for (const id of ids) {
    const it = need(u, id, 'edit');
    if (it.parent_id === dest.parent && it.owner_id === dest.owner) continue;
    moveItem(u, it, dest);
    log(it.id, u, 'move', destName);
    n++;
  }
  res.json({ moved: n });
}));
api.post('/copy', h(async (req, res) => {
  const u = req.user, ids = [].concat(req.body.ids || []);
  const out = [];
  for (const id of ids) {
    const it = need(u, id);
    let tgt;
    if (req.body.target !== undefined) tgt = resolveParent(u, req.body.target);
    else if (canEdit(it.perm)) tgt = { owner: it.owner_id, parent: it.parent_id };
    else tgt = { owner: u.id, parent: null };
    const size = descendants(it.id).filter(d => !d.trashed_at).reduce((s, d) => s + d.size, 0);
    checkQuota(tgt.owner, size);
    const c = copyTree(it, tgt.parent, tgt.owner, u, req.body.target === undefined && tgt.parent === it.parent_id && tgt.owner === it.owner_id);
    log(c.id, u, 'copy', it.name);
    out.push(ser(c, u));
  }
  res.json({ items: out });
}));
api.post('/trash', h(async (req, res) => {
  for (const id of [].concat(req.body.ids || [])) { const it = need(req.user, id, 'edit'); if (!it.trashed_at) { trashItem(it); log(it.id, req.user, 'trash'); } }
  res.json({ ok: true });
}));
api.post('/restore', h(async (req, res) => {
  for (const id of [].concat(req.body.ids || [])) { const it = need(req.user, id, 'edit'); if (it.trashed_at) { restoreItem(it); log(it.id, req.user, 'restore'); } }
  res.json({ ok: true });
}));
api.post('/purge', h(async (req, res) => {
  for (const id of [].concat(req.body.ids || [])) { const it = need(req.user, id, 'owner'); purgeItem(it); }
  res.json({ ok: true });
}));
api.post('/trash/empty', h(async (req, res) => {
  const owners = [req.user.id, ...myTeams(req.user.id).filter(t => t.role === 'manager').map(t => t.id)];
  for (const o of owners) for (const it of db.prepare('SELECT * FROM items WHERE owner_id=? AND trash_root=1').all(o)) purgeItem(it);
  res.json({ ok: true });
}));

/* --- Espaces d'équipe --- */
function teamOut(t, withMembers) {
  const o = { id: t.id, name: t.name, quota: t.quota, used: used(t.id), created: t.created, files: db.prepare("SELECT COUNT(*) c FROM items WHERE owner_id=? AND type='file'").get(t.id).c };
  if (withMembers) o.members = db.prepare('SELECT m.user_id, m.role, u.name, u.email FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.name COLLATE NOCASE').all(t.id);
  return o;
}
function needTeam(req, manage) {
  const t = getUser(req.params.id);
  if (!t || t.kind !== 'team') throw E(404, 'Espace introuvable');
  const role = teamRole(t.id, req.user.id);
  if (req.user.role !== 'admin' && (!role || (manage && role !== 'manager'))) throw E(403, 'Droits insuffisants');
  return t;
}
api.get('/teams/:id', h(async (req, res) => res.json(teamOut(needTeam(req, false), true))));
api.post('/teams/:id/members', h(async (req, res) => {
  const t = needTeam(req, true);
  const target = db.prepare("SELECT * FROM users WHERE email=? AND kind='user'").get(String(req.body.email || '').trim());
  if (!target) throw E(404, 'Aucun utilisateur avec cette adresse');
  const role = ROLE_PERM[req.body.role] ? req.body.role : 'member';
  db.prepare('INSERT INTO team_members(team_id,user_id,role) VALUES(?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role').run(t.id, target.id, role);
  res.json({ ok: true });
}));
api.delete('/teams/:id/members/:uid', h(async (req, res) => {
  const t = needTeam(req, req.params.uid !== req.user.id);
  db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?').run(t.id, req.params.uid);
  res.json({ ok: true });
}));
api.get('/admin/teams', admin, (req, res) => res.json(db.prepare("SELECT * FROM users WHERE kind='team' ORDER BY name COLLATE NOCASE").all().map(t => teamOut(t, true))));
api.post('/admin/teams', admin, h(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) throw E(400, 'Nom obligatoire');
  if (db.prepare("SELECT 1 FROM users WHERE kind='team' AND name=? COLLATE NOCASE").get(name)) throw E(409, 'Un espace porte déjà ce nom');
  const id = uid();
  db.prepare("INSERT INTO users(id,email,name,password,role,quota,disabled,created,kind) VALUES(?,?,?,?,?,?,1,?,'team')")
    .run(id, `team-${id}@espace.local`, name, '!', 'user', req.body.quota != null ? parseSize(req.body.quota) : 0, now());
  if (req.body.addMe !== false) db.prepare('INSERT INTO team_members(team_id,user_id,role) VALUES(?,?,?)').run(id, req.user.id, 'manager');
  res.json({ id });
}));
api.patch('/admin/teams/:id', admin, h(async (req, res) => {
  const t = needTeam(req, true);
  if (req.body.name) {
    const n = String(req.body.name).trim().slice(0, 80);
    if (db.prepare("SELECT 1 FROM users WHERE kind='team' AND name=? COLLATE NOCASE AND id<>?").get(n, t.id)) throw E(409, 'Un espace porte déjà ce nom');
    db.prepare('UPDATE users SET name=? WHERE id=?').run(n, t.id);
  }
  if (req.body.quota != null) db.prepare('UPDATE users SET quota=? WHERE id=?').run(parseSize(req.body.quota), t.id);
  res.json({ ok: true });
}));
api.delete('/admin/teams/:id', admin, h(async (req, res) => {
  const t = needTeam(req, true);
  for (const it of db.prepare('SELECT * FROM items WHERE owner_id=? AND parent_id IS NULL').all(t.id)) purgeItem(it);
  db.prepare('DELETE FROM users WHERE id=?').run(t.id);
  res.json({ ok: true });
}));

/* --- Téléchargement --- */
api.get('/items/:id/raw', h(async (req, res) => {
  const it = need(req.user, req.params.id);
  if (it.type === 'folder') return zipTo(res, [it], it.name + '.zip');
  if (req.query.dl) log(it.id, req.user, 'download');
  sendRaw(res, fpath(it.id), it.name, it.mime, !!req.query.dl);
}));
api.get('/zip', h(async (req, res) => {
  const items = String(req.query.ids || '').split(',').filter(Boolean).map(id => need(req.user, id));
  if (!items.length) throw E(400, 'Aucun élément');
  zipTo(res, items, items.length === 1 ? items[0].name + '.zip' : `${C.APP_NAME} - ${new Date().toISOString().slice(0, 10)}.zip`);
}));

/* --- Versions --- */
api.get('/items/:id/versions', h(async (req, res) => {
  const it = need(req.user, req.params.id);
  res.json({ current: { version: it.version, size: it.size, modified: it.modified, author: it.modified_by }, versions: db.prepare('SELECT id, version, size, created, author FROM versions WHERE item_id=? ORDER BY version DESC').all(it.id) });
}));
api.get('/versions/:vid/raw', h(async (req, res) => {
  const v = db.prepare('SELECT * FROM versions WHERE id=?').get(req.params.vid);
  if (!v) throw E(404, 'Version introuvable');
  const it = need(req.user, v.item_id);
  const d = it.name.lastIndexOf('.');
  sendRaw(res, vpath(v.id), (d > 0 ? it.name.slice(0, d) : it.name) + ` (v${v.version})` + (d > 0 ? it.name.slice(d) : ''), it.mime, true);
}));
api.post('/versions/:vid/restore', h(async (req, res) => {
  const v = db.prepare('SELECT * FROM versions WHERE id=?').get(req.params.vid);
  if (!v) throw E(404, 'Version introuvable');
  const it = need(req.user, v.item_id, 'edit');
  const buf = fs.readFileSync(vpath(v.id));
  saveNewVersion(it, buf, req.user.name);
  log(it.id, req.user, 'version', 'Restauration de la version ' + v.version);
  res.json({ ok: true });
}));

/* --- Partage interne --- */
api.get('/items/:id/shares', h(async (req, res) => {
  const it = need(req.user, req.params.id);
  res.json({
    perm: it.perm, owner: getUser(it.owner_id).name,
    access: db.prepare('SELECT a.user_id, a.perm, u.name, u.email FROM access a JOIN users u ON u.id=a.user_id WHERE a.item_id=? ORDER BY u.name').all(it.id),
    links: it.perm === 'owner' ? db.prepare('SELECT token, mode, expires, created, views, (password IS NOT NULL) AS protected FROM links WHERE item_id=? ORDER BY created DESC').all(it.id).map(l => ({ ...l, protected: !!l.protected, url: `${C.APP_URL}/s/${l.token}` })) : [],
  });
}));
api.post('/items/:id/access', h(async (req, res) => {
  const it = need(req.user, req.params.id, 'owner');
  const target = db.prepare("SELECT * FROM users WHERE email=? AND kind='user'").get(String(req.body.email || '').trim());
  if (!target) throw E(404, 'Aucun utilisateur avec cette adresse');
  if (target.id === req.user.id) throw E(400, 'Vous êtes déjà propriétaire');
  const p = req.body.perm === 'edit' ? 'edit' : 'view';
  db.prepare('INSERT INTO access(item_id,user_id,perm,created) VALUES(?,?,?,?) ON CONFLICT(item_id,user_id) DO UPDATE SET perm=excluded.perm').run(it.id, target.id, p, now());
  log(it.id, req.user, 'share', `${target.name} (${p === 'edit' ? 'modification' : 'lecture'})`);
  res.json({ ok: true });
}));
api.delete('/items/:id/access/:uid', h(async (req, res) => {
  const it = need(req.user, req.params.id);
  if (it.perm !== 'owner' && req.params.uid !== req.user.id) throw E(403, 'Droits insuffisants');
  db.prepare('DELETE FROM access WHERE item_id=? AND user_id=?').run(it.id, req.params.uid);
  res.json({ ok: true });
}));
api.get('/users/lookup', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  res.json(db.prepare(`SELECT name, email FROM users WHERE disabled=0 AND kind='user' AND id<>? AND (email LIKE ? OR name LIKE ?) LIMIT 8`).all(req.user.id, `%${q}%`, `%${q}%`));
}));

/* --- Liens publics --- */
const LINK_MODES = ['view', 'edit', 'upload'];
api.post('/items/:id/links', h(async (req, res) => {
  const it = need(req.user, req.params.id, 'owner');
  const mode = LINK_MODES.includes(req.body.mode) ? req.body.mode : 'view';
  if (mode === 'upload' && it.type !== 'folder') throw E(400, 'Le mode dépôt est réservé aux dossiers');
  const token = crypto.randomBytes(12).toString('base64url');
  db.prepare('INSERT INTO links(token,item_id,mode,password,expires,created_by,created) VALUES(?,?,?,?,?,?,?)')
    .run(token, it.id, mode, req.body.password ? bcrypt.hashSync(String(req.body.password), 10) : null, req.body.expires ? Number(new Date(req.body.expires + 'T23:59:59')) : null, req.user.id, now());
  log(it.id, req.user, 'link', mode);
  res.json({ token, url: `${C.APP_URL}/s/${token}` });
}));
api.patch('/links/:token', h(async (req, res) => {
  const l = db.prepare('SELECT * FROM links WHERE token=?').get(req.params.token);
  if (!l) throw E(404, 'Lien introuvable');
  const it = need(req.user, l.item_id, 'owner');
  if (req.body.mode && LINK_MODES.includes(req.body.mode)) {
    if (req.body.mode === 'upload' && it.type !== 'folder') throw E(400, 'Le mode dépôt est réservé aux dossiers');
    db.prepare('UPDATE links SET mode=? WHERE token=?').run(req.body.mode, l.token);
  }
  if (req.body.expires !== undefined) db.prepare('UPDATE links SET expires=? WHERE token=?').run(req.body.expires ? Number(new Date(req.body.expires + 'T23:59:59')) : null, l.token);
  if (req.body.password !== undefined) db.prepare('UPDATE links SET password=? WHERE token=?').run(req.body.password ? bcrypt.hashSync(String(req.body.password), 10) : null, l.token);
  res.json({ ok: true });
}));
api.delete('/links/:token', h(async (req, res) => {
  const l = db.prepare('SELECT * FROM links WHERE token=?').get(req.params.token);
  if (!l) throw E(404, 'Lien introuvable');
  need(req.user, l.item_id, 'owner');
  db.prepare('DELETE FROM links WHERE token=?').run(l.token);
  res.json({ ok: true });
}));

/* --- OnlyOffice (utilisateur connecté) --- */
function ooConfig({ item, user, mode, fileUrl, callbackUrl, backUrl }) {
  const ext = EXT(item.name);
  const conf = {
    document: {
      fileType: ext, key: `${item.id}-${item.version}`, title: item.name, url: fileUrl,
      permissions: { edit: mode === 'edit', download: true, print: true, comment: mode === 'edit', review: mode === 'edit', fillForms: mode === 'edit' },
    },
    documentType: docType(ext),
    editorConfig: {
      mode, lang: 'fr', region: 'fr-FR', callbackUrl,
      user: { id: user.id, name: user.name },
      customization: { forcesave: true, autosave: true, compactHeader: false, goback: backUrl ? { url: backUrl, text: 'Retour au drive', blank: false } : undefined },
    },
  };
  const clean = JSON.parse(JSON.stringify(conf));
  if (C.OO_SECRET) clean.token = jwt.sign(clean, C.OO_SECRET);
  return clean;
}
function dsUrls(item, share) {
  const ft = jwt.sign({ fid: item.id, k: 'file' }, SECRET, { expiresIn: '24h' });
  const ct = jwt.sign({ fid: item.id, k: 'cb', share: share || null }, SECRET, { expiresIn: '7d' });
  return { fileUrl: `${DS_BASE}/oo/file/${item.id}?t=${ft}`, callbackUrl: `${DS_BASE}/oo/callback/${item.id}?t=${ct}` };
}
api.get('/oo/:id', h(async (req, res) => {
  if (!ooEnabled()) throw E(400, "OnlyOffice n'est pas configuré sur ce serveur");
  const u = req.user, it = need(u, req.params.id);
  const ext = EXT(it.name);
  if (it.type !== 'file' || !docType(ext)) throw E(400, "Ce format ne s'ouvre pas dans OnlyOffice");
  const mode = canEdit(it.perm) && OO_EDIT.includes(ext) && req.query.mode !== 'view' ? 'edit' : 'view';
  const back = it.parent_id && perm(u, getItem(it.parent_id)) ? `${C.APP_URL}/#f-${it.parent_id}` : isTeam(it.owner_id) ? `${C.APP_URL}/#t-${it.owner_id}` : `${C.APP_URL}/`;
  log(it.id, u, 'open', mode === 'edit' ? 'OnlyOffice (modification)' : 'OnlyOffice (lecture)');
  res.json({ ooUrl: C.OO_URL, mode, name: it.name, config: ooConfig({ item: it, user: u, mode, ...dsUrls(it), backUrl: back }) });
}));

/* --- Administration --- */
api.get('/admin/users', admin, (req, res) => {
  res.json({
    users: db.prepare("SELECT * FROM users WHERE kind='user' ORDER BY name COLLATE NOCASE").all().map(u => ({ ...pubUser(u), used: used(u.id), files: db.prepare("SELECT COUNT(*) c FROM items WHERE owner_id=? AND type='file'").get(u.id).c })),
    settings: { allow_signup: setting('allow_signup', process.env.ALLOW_SIGNUP === 'true' ? '1' : '0') === '1', default_quota: C.DEFAULT_QUOTA, configurable: false },
    disk: (() => { try { const s = fs.statfsSync(DATA); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch (e) { return null; } })(),
  });
});
api.post('/admin/users', admin, h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), name = String(req.body.name || '').trim(), pw = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw E(400, 'Adresse e-mail invalide');
  if (!name) throw E(400, 'Nom obligatoire');
  if (pw.length < 8) throw E(400, 'Mot de passe : 8 caractères minimum');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw E(409, 'Adresse déjà utilisée');
  db.prepare('INSERT INTO users(id,email,name,password,role,quota,created) VALUES(?,?,?,?,?,?,?)')
    .run(uid(), email, name, bcrypt.hashSync(pw, 10), req.body.role === 'admin' ? 'admin' : 'user', req.body.quota != null ? parseSize(req.body.quota) : C.DEFAULT_QUOTA, now());
  res.json({ ok: true });
}));
api.patch('/admin/users/:id', admin, h(async (req, res) => {
  const u = getUser(req.params.id); if (!u || u.kind !== 'user') throw E(404, 'Utilisateur introuvable');
  const b = req.body;
  if (b.reset2fa) db.prepare('UPDATE users SET totp_secret=NULL, totp_pending=NULL, recovery=NULL WHERE id=?').run(u.id);
  if (b.name) db.prepare('UPDATE users SET name=? WHERE id=?').run(String(b.name).trim(), u.id);
  if (b.role && u.id !== req.user.id) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role === 'admin' ? 'admin' : 'user', u.id);
  if (b.quota != null) db.prepare('UPDATE users SET quota=? WHERE id=?').run(parseSize(b.quota), u.id);
  if (b.disabled != null && u.id !== req.user.id) db.prepare('UPDATE users SET disabled=? WHERE id=?').run(b.disabled ? 1 : 0, u.id);
  if (b.password) { if (String(b.password).length < 8) throw E(400, 'Mot de passe : 8 caractères minimum'); db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(String(b.password), 10), u.id); }
  res.json({ ok: true });
}));
api.delete('/admin/users/:id', admin, h(async (req, res) => {
  const u = getUser(req.params.id); if (!u) throw E(404, 'Utilisateur introuvable');
  if (u.id === req.user.id) throw E(400, 'Vous ne pouvez pas supprimer votre propre compte');
  for (const it of db.prepare('SELECT * FROM items WHERE owner_id=? AND parent_id IS NULL').all(u.id)) purgeItem(it);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  res.json({ ok: true });
}));
api.put('/admin/settings', admin, h(async (req, res) => {
  if (req.body.allow_signup != null) setSetting('allow_signup', req.body.allow_signup ? '1' : '0');
  res.json({ ok: true });
}));

/* ============================== Liens publics ============================== */
const pub = express.Router();
function linkCtx(req) {
  const l = db.prepare('SELECT * FROM links WHERE token=?').get(req.params.token);
  if (!l) throw E(404, "Ce lien n'existe pas ou a été supprimé");
  if (l.expires && l.expires < now()) throw E(410, 'Ce lien a expiré');
  const item = getItem(l.item_id);
  if (!item || item.trashed_at) throw E(404, "L'élément partagé n'est plus disponible");
  if (l.password) {
    let ok = false;
    try { ok = jwt.verify(req.cookies['ed_l_' + l.token], SECRET).t === l.token; } catch (e) { }
    if (!ok) throw E(401, 'Mot de passe requis', { needPassword: true });
  }
  return { link: l, item };
}
function inLink(ctx, id) {
  if (!id || id === ctx.item.id) return ctx.item;
  const it = getItem(id);
  if (!it || it.trashed_at) throw E(404, 'Élément introuvable');
  if (!ancestors(it.id).some(a => a.id === ctx.item.id)) throw E(404, 'Élément introuvable');
  return it;
}
const guestName = req => String(req.query.name || 'Invité').trim().slice(0, 60) || 'Invité';
pub.get('/:token', h(async (req, res) => {
  const ctx = linkCtx(req);
  db.prepare('UPDATE links SET views=views+1 WHERE token=?').run(ctx.link.token);
  res.json({ appName: C.APP_NAME, mode: ctx.link.mode, owner: getUser(ctx.item.owner_id).name, item: ser(ctx.item, null), onlyoffice: ooEnabled() ? { edit: OO_EDIT, view: Object.values(OO_TYPES).flat() } : null });
}));
pub.post('/:token/unlock', h(async (req, res) => {
  const l = db.prepare('SELECT * FROM links WHERE token=?').get(req.params.token);
  if (!l) throw E(404, 'Lien introuvable');
  const key = 'link|' + req.ip + '|' + l.token, a = throttle(key);
  if (!l.password || !bcrypt.compareSync(String(req.body.password || ''), l.password)) { failed(key, a); throw E(401, 'Mot de passe incorrect'); }
  res.cookie('ed_l_' + l.token, jwt.sign({ t: l.token }, SECRET, { expiresIn: '12h' }), { httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: 12 * 3600e3 });
  res.json({ ok: true });
}));
pub.get('/:token/list', h(async (req, res) => {
  const ctx = linkCtx(req);
  if (ctx.link.mode === 'upload') throw E(403, 'Ce lien permet uniquement le dépôt de fichiers');
  const f = inLink(ctx, req.query.folder);
  if (f.type !== 'folder') throw E(400, "Ce n'est pas un dossier");
  const anc = ancestors(f.id); const k = anc.findIndex(a => a.id === ctx.item.id);
  res.json({
    folder: ser(f, null), path: anc.slice(k).map(a => ({ id: a.id, name: a.name })),
    items: db.prepare('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL').all(f.id).map(i => ser(i, null)),
  });
}));
pub.get('/:token/raw/:id', h(async (req, res) => {
  const ctx = linkCtx(req);
  if (ctx.link.mode === 'upload') throw E(403, 'Accès refusé');
  const it = inLink(ctx, req.params.id);
  if (it.type === 'folder') return zipTo(res, [it], it.name + '.zip');
  sendRaw(res, fpath(it.id), it.name, it.mime, !!req.query.dl);
}));
pub.post('/:token/upload', upload.array('files'), h(async (req, res) => {
  let ctx, f;
  try {
    ctx = linkCtx(req);
    if (!['upload', 'edit'].includes(ctx.link.mode)) throw E(403, "Ce lien ne permet pas l'envoi de fichiers");
    f = inLink(ctx, req.query.folder);
    if (f.type !== 'folder') throw E(400, 'Destination invalide');
  } catch (e) { (req.files || []).forEach(x => fs.rmSync(x.path, { force: true })); throw e; }
  const guest = { id: null, name: guestName(req) + ' (lien)' };
  const items = storeUploads(req.files || [], req.body.paths, f.owner_id, f.id, guest);
  res.json({ count: items.length });
}));
pub.post('/:token/folders', h(async (req, res) => {
  const ctx = linkCtx(req);
  if (ctx.link.mode !== 'edit') throw E(403, 'Droits insuffisants');
  const f = inLink(ctx, req.body.parent);
  const it = createItem({ owner: f.owner_id, parent: f.id, type: 'folder', name: req.body.name, by: guestName(req) + ' (lien)' });
  res.json(ser(it, null));
}));
pub.get('/:token/oo/:id', h(async (req, res) => {
  if (!ooEnabled()) throw E(400, "OnlyOffice n'est pas configuré");
  const ctx = linkCtx(req);
  if (ctx.link.mode === 'upload') throw E(403, 'Accès refusé');
  const it = inLink(ctx, req.params.id);
  const ext = EXT(it.name);
  if (it.type !== 'file' || !docType(ext)) throw E(400, "Ce format ne s'ouvre pas dans OnlyOffice");
  const mode = ctx.link.mode === 'edit' && OO_EDIT.includes(ext) ? 'edit' : 'view';
  const name = guestName(req);
  const guest = { id: 'guest-' + crypto.createHash('sha1').update(req.ip + name).digest('hex').slice(0, 10), name: name + ' (invité)' };
  res.json({ ooUrl: C.OO_URL, mode, name: it.name, config: ooConfig({ item: it, user: guest, mode, ...dsUrls(it, ctx.link.token), backUrl: `${C.APP_URL}/s/${ctx.link.token}` }) });
}));
app.use('/api/s', pub);
app.use('/api', api);

/* ============================== Points d'entrée OnlyOffice ============================== */
app.get('/oo/file/:id', h(async (req, res) => {
  let p; try { p = jwt.verify(String(req.query.t), SECRET); } catch (e) { throw E(403, 'Jeton invalide'); }
  if (p.k !== 'file' || p.fid !== req.params.id) throw E(403, 'Jeton invalide');
  const it = getItem(p.fid); if (!it) throw E(404, 'Introuvable');
  res.sendFile(fpath(it.id), { headers: { 'Content-Type': it.mime || 'application/octet-stream' } });
}));
app.post('/oo/callback/:id', express.json({ limit: '10mb' }), h(async (req, res) => {
  let p; try { p = jwt.verify(String(req.query.t), SECRET); } catch (e) { return res.json({ error: 1 }); }
  if (p.k !== 'cb' || p.fid !== req.params.id) return res.json({ error: 1 });
  let body = req.body || {};
  if (C.OO_SECRET) {
    const tok = body.token || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    try { const d = jwt.verify(tok, C.OO_SECRET); body = d.payload || d; } catch (e) { console.warn('[OnlyOffice] jeton de callback invalide'); return res.json({ error: 1 }); }
  }
  const it = getItem(req.params.id);
  if (!it) return res.json({ error: 1 });
  if ((body.status === 2 || body.status === 6) && body.url) {
    try {
      const r = await fetch(body.url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const uidEditor = (body.users || [])[0] || (body.actions || [])[0]?.userid;
      const editor = uidEditor && getUser(uidEditor);
      const author = editor ? editor.name : 'Invité (lien)';
      saveNewVersion(it, buf, author, body.filetype);
      log(it.id, editor || { id: null, name: author }, 'edit', body.status === 6 ? 'Enregistrement OnlyOffice' : 'Modifié dans OnlyOffice');
    } catch (e) { console.error('[OnlyOffice] échec de l\'enregistrement :', e.message); return res.json({ error: 1 }); }
  }
  res.json({ error: 0 });
}));

/* ============================== Pages ============================== */
const PUB = path.join(__dirname, '..', 'public');
app.use(express.static(PUB, {
  index: false,
  setHeaders: (res, file) => {
    // Revalidation systématique (ETag) pour récupérer les mises à jour dès le déploiement
    res.set('Cache-Control', /\.(png|svg)$/.test(file) ? 'public, max-age=86400' : 'no-cache');
    if (file.endsWith('sw.js')) res.set('Service-Worker-Allowed', '/');
  },
}));
app.get('/login', (req, res) => res.sendFile(path.join(PUB, 'login.html')));
app.get('/edit/:id', (req, res) => (currentUser(req) ? res.sendFile(path.join(PUB, 'editor.html')) : res.redirect('/login')));
app.get('/s/:token', (req, res) => res.sendFile(path.join(PUB, 'share.html')));
app.get('/s/:token/edit/:id', (req, res) => res.sendFile(path.join(PUB, 'editor.html')));
app.get('/', (req, res) => (currentUser(req) ? res.sendFile(path.join(PUB, 'app.html')) : res.redirect('/login')));
app.get('/healthz', (req, res) => res.json({ ok: true }));
// Partage depuis Android (si le service worker n'a pas intercepté la requête)
app.post('/share-target', (req, res) => res.redirect(303, '/'));

/* --- Erreurs --- */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) err = E(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux' : 'Envoi invalide');
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: status >= 500 ? 'Erreur interne du serveur' : err.message, ...(err.extra || {}) });
});

/* ============================== Tâches ============================== */
function maintenance() {
  const limit = now() - C.TRASH_DAYS * 864e5;
  for (const it of db.prepare('SELECT * FROM items WHERE trash_root=1 AND trashed_at < ?').all(limit)) purgeItem(it);
  db.prepare('DELETE FROM links WHERE expires IS NOT NULL AND expires < ?').run(now() - 30 * 864e5);
  db.prepare('DELETE FROM activity WHERE at < ?').run(now() - 365 * 864e5);
  const tmp = path.join(DATA, 'tmp');
  for (const f of fs.readdirSync(tmp)) { const p = path.join(tmp, f); try { if (fs.statSync(p).mtimeMs < now() - 864e5) fs.rmSync(p, { force: true }); } catch (e) { } }
}
setInterval(maintenance, 6 * 3600e3).unref();
maintenance();
indexer.backlog();

// Compte administrateur initial depuis les variables d'environnement
if (C.ADMIN_EMAIL && C.ADMIN_PASSWORD && !db.prepare('SELECT 1 FROM users WHERE email=?').get(C.ADMIN_EMAIL)) {
  db.prepare('INSERT INTO users(id,email,name,password,role,quota,created) VALUES(?,?,?,?,?,?,?)')
    .run(uid(), C.ADMIN_EMAIL.toLowerCase(), 'Administrateur', bcrypt.hashSync(C.ADMIN_PASSWORD, 10), 'admin', 0, now());
  console.log('Compte administrateur créé :', C.ADMIN_EMAIL);
}

app.listen(C.PORT, () => {
  console.log(`${C.APP_NAME} démarré sur le port ${C.PORT} — ${C.APP_URL}`);
  console.log(ooEnabled() ? `OnlyOffice : ${C.OO_URL} (JWT ${C.OO_SECRET ? 'activé' : 'désactivé'})` : 'OnlyOffice : non configuré');
});
