'use strict';
/*
 * Serveur WebDAV (classe 1 + verrous simulés, suffisant pour Windows, macOS, Linux, OnlyOffice mobile…)
 *   /dav/Mon espace/…              fichiers de l'utilisateur
 *   /dav/Équipes/<espace>/…        espaces d'équipe
 *   /dav/Partagés avec moi/…       éléments partagés avec l'utilisateur
 * Authentification : Basic (adresse e-mail + mot de passe d'application ;
 * le mot de passe du compte est accepté uniquement si la double authentification est désactivée).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

module.exports = function mountDav(app, X) {
  const { db, C, DATA, getUser, perm, canEdit, myTeams, ROLE_PERM, cleanName, createItem, saveNewVersion, trashItem, moveItem, copyTree,
    checkQuota, used, fpath, uid, now, log, indexer, mime, bcrypt, throttle, failed, descendants, checkAppPassword } = X;
  const MINE = 'Mon espace', TEAMS = 'Équipes', SHARED = 'Partagés avec moi';
  const PREFIX = '/dav';
  const START = Date.now();
  const authCache = new Map();

  /* ---------- Authentification ---------- */
  function authenticate(req) {
    const hdr = req.get('Authorization') || '';
    if (!hdr.startsWith('Basic ')) return null;
    const key = crypto.createHash('sha256').update(hdr).digest('hex');
    const c = authCache.get(key);
    if (c && c.exp > now()) { const u = getUser(c.uid); if (u && !u.disabled) return u; }
    const dec = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i < 0) return null;
    const email = dec.slice(0, i).trim(), pw = dec.slice(i + 1);
    const tk = 'dav|' + req.ip + '|' + email.toLowerCase();
    const a = throttle(tk);
    const u = db.prepare("SELECT * FROM users WHERE email=? AND kind='user'").get(email);
    const ok = !!u && !u.disabled && (checkAppPassword(u, pw) || (!u.totp_secret && bcrypt.compareSync(pw, u.password)));
    if (!ok) { failed(tk, a); return null; }
    authCache.set(key, { uid: u.id, exp: now() + 5 * 60e3 });
    if (authCache.size > 5000) authCache.clear();
    return u;
  }

  /* ---------- Résolution des chemins ---------- */
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const segsOf = p => p.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
  const listDir = d => (d.parent
    ? db.prepare('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL ORDER BY name COLLATE NOCASE').all(d.parent)
    : db.prepare('SELECT * FROM items WHERE parent_id IS NULL AND owner_id=? AND trashed_at IS NULL ORDER BY name COLLATE NOCASE').all(d.owner));
  const findChild = (d, name) => (d.parent
    ? db.prepare('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL AND name=? COLLATE NOCASE').get(d.parent, name)
    : db.prepare('SELECT * FROM items WHERE parent_id IS NULL AND owner_id=? AND trashed_at IS NULL AND name=? COLLATE NOCASE').get(d.owner, name));
  const sharedRoots = user => db.prepare('SELECT i.* FROM items i JOIN access a ON a.item_id=i.id WHERE a.user_id=? AND i.trashed_at IS NULL ORDER BY i.name COLLATE NOCASE').all(user.id);
  const dirOfItem = (it, p) => ({ owner: it.owner_id, parent: it.id, perm: p, name: it.name });

  function resolve(user, segs) {
    if (!segs.length) return { kind: 'vroot' };
    const [a, ...rest] = segs;
    let d;
    if (eq(a, MINE)) d = { owner: user.id, parent: null, perm: 'owner', name: MINE };
    else if (eq(a, TEAMS)) {
      if (!rest.length) return { kind: 'vteams' };
      const t = myTeams(user.id).find(x => eq(x.name, rest[0]));
      if (!t) return null;
      rest.shift();
      d = { owner: t.id, parent: null, perm: ROLE_PERM[t.role], name: t.name };
    } else if (eq(a, SHARED)) {
      if (!rest.length) return { kind: 'vshared' };
      const it = sharedRoots(user).find(x => eq(x.name, rest[0]));
      if (!it) return null;
      rest.shift();
      const p = perm(user, it);
      if (!rest.length) return { kind: 'item', item: it, perm: p, dir: null };
      if (it.type !== 'folder') return null;
      d = dirOfItem(it, p);
    } else return null;
    if (!rest.length) return { kind: 'dir', dir: d };
    for (let i = 0; i < rest.length; i++) {
      const last = i === rest.length - 1;
      const child = findChild(d, rest[i]);
      if (!child) return last ? { kind: 'missing', dir: d, name: rest[i] } : null;
      const p = d.perm === 'owner' ? 'owner' : (perm(user, child) || d.perm);
      if (last) return { kind: 'item', item: child, perm: p, dir: d };
      if (child.type !== 'folder') return null;
      d = dirOfItem(child, p);
    }
    return null;
  }

  /* ---------- XML ---------- */
  const x = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const hrefOf = (segs, isDir) => PREFIX + '/' + segs.map(s => encodeURIComponent(s)).join('/') + (isDir && segs.length ? '/' : '');
  function entry(href, o) {
    return `<d:response><d:href>${x(href)}</d:href><d:propstat><d:prop>`
      + `<d:displayname>${x(o.name)}</d:displayname>`
      + `<d:resourcetype>${o.dir ? '<d:collection/>' : ''}</d:resourcetype>`
      + (o.dir ? '' : `<d:getcontentlength>${o.size || 0}</d:getcontentlength><d:getcontenttype>${x(o.mime || 'application/octet-stream')}</d:getcontenttype>`)
      + `<d:getlastmodified>${new Date(o.mtime || START).toUTCString()}</d:getlastmodified>`
      + `<d:creationdate>${new Date(o.ctime || o.mtime || START).toISOString()}</d:creationdate>`
      + `<d:getetag>"${x(o.etag || 'v')}"</d:getetag>`
      + (o.quota ? `<d:quota-used-bytes>${o.quota.used}</d:quota-used-bytes><d:quota-available-bytes>${o.quota.avail}</d:quota-available-bytes>` : '')
      + '<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>'
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  }
  const quotaOf = ownerId => {
    const u = getUser(ownerId), usedB = used(ownerId);
    let avail = u && u.quota > 0 ? Math.max(0, u.quota - usedB) : null;
    if (avail === null) { try { const s = fs.statfsSync(DATA); avail = s.bavail * s.bsize; } catch (e) { avail = 1024 ** 4; } }
    return { used: usedB, avail };
  };
  const itemProps = it => ({
    name: it.name, dir: it.type === 'folder', size: it.size, mime: it.mime, mtime: it.modified, ctime: it.created,
    etag: it.type === 'folder' ? `${it.id}-${it.modified}` : `${it.id}-${it.version}-${it.size}`,
  });
  function multistatus(res, parts) {
    res.status(207).set('Content-Type', 'application/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`);
  }
  const readBody = req => new Promise((ok, ko) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 1e6) { ko(new Error('trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', ko);
  });

  /* ---------- Méthodes ---------- */
  const DAV_HEADERS = {
    DAV: '1, 2', 'MS-Author-Via': 'DAV',
    Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
  };

  async function propfind(req, res, user, segs, r) {
    await readBody(req).catch(() => '');
    const depth = req.get('Depth') === '0' ? 0 : 1;
    const parts = [];
    const self = hrefOf(segs, r.kind !== 'item' || r.item.type === 'folder');
    if (r.kind === 'vroot') {
      parts.push(entry(self, { name: C.APP_NAME, dir: true, etag: 'root', quota: quotaOf(user.id) }));
      if (depth) {
        parts.push(entry(hrefOf([MINE], true), { name: MINE, dir: true, etag: 'mine', quota: quotaOf(user.id) }));
        if (myTeams(user.id).length) parts.push(entry(hrefOf([TEAMS], true), { name: TEAMS, dir: true, etag: 'teams' }));
        if (sharedRoots(user).length) parts.push(entry(hrefOf([SHARED], true), { name: SHARED, dir: true, etag: 'shared' }));
      }
    } else if (r.kind === 'vteams') {
      parts.push(entry(self, { name: TEAMS, dir: true, etag: 'teams' }));
      if (depth) for (const t of myTeams(user.id)) parts.push(entry(hrefOf([TEAMS, t.name], true), { name: t.name, dir: true, etag: 't' + t.id, quota: quotaOf(t.id) }));
    } else if (r.kind === 'vshared') {
      parts.push(entry(self, { name: SHARED, dir: true, etag: 'shared' }));
      if (depth) for (const it of sharedRoots(user)) parts.push(entry(hrefOf([SHARED, it.name], it.type === 'folder'), itemProps(it)));
    } else if (r.kind === 'dir') {
      parts.push(entry(self, { name: r.dir.name, dir: true, etag: 'd' + r.dir.owner, quota: quotaOf(r.dir.owner) }));
      if (depth) for (const it of listDir(r.dir)) parts.push(entry(hrefOf([...segs, it.name], it.type === 'folder'), itemProps(it)));
    } else if (r.kind === 'item') {
      parts.push(entry(self, itemProps(r.item)));
      if (depth && r.item.type === 'folder') for (const it of listDir(dirOfItem(r.item, r.perm))) parts.push(entry(hrefOf([...segs, it.name], it.type === 'folder'), itemProps(it)));
    }
    multistatus(res, parts);
  }

  async function put(req, res, user, segs, r) {
    if (r.kind === 'item' && r.item.type === 'folder') return res.sendStatus(405);
    if (r.kind !== 'item' && r.kind !== 'missing') return res.sendStatus(409);
    if (!canEdit(r.kind === 'missing' ? r.dir.perm : r.perm)) return res.sendStatus(403);
    const owner = r.kind === 'missing' ? r.dir.owner : r.item.owner_id;
    const tmp = path.join(DATA, 'tmp', 'dav-' + uid());
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      const size = fs.statSync(tmp).size;
      try { checkQuota(owner, size); } catch (e) { fs.rmSync(tmp, { force: true }); return res.sendStatus(507); }
      if (r.kind === 'missing') {
        const name = cleanName(r.name);
        const it = createItem({ owner, parent: r.dir.parent, type: 'file', name, size, mimeType: mime.lookup(name) || 'application/octet-stream', by: user.name });
        fs.renameSync(tmp, fpath(it.id));
        indexer.enqueue(it.id);
        if (size > 0) log(it.id, user, 'upload', 'WebDAV');
        return res.sendStatus(201);
      }
      const wasEmpty = r.item.size === 0;
      saveNewVersion(r.item, tmp, user.name);
      log(r.item.id, user, wasEmpty ? 'upload' : 'edit', 'WebDAV');
      return res.sendStatus(204);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  async function moveOrCopy(req, res, user, segs, r, isMove) {
    if (r.kind !== 'item') return res.sendStatus(403);
    if (isMove && !canEdit(r.perm)) return res.sendStatus(403);
    if (isMove && !r.dir) return res.sendStatus(403); // racine d'un partage reçu
    let dpath;
    try { dpath = new URL(req.get('Destination') || '', 'http://local').pathname; } catch (e) { return res.sendStatus(400); }
    const k = dpath.indexOf(PREFIX + '/');
    if (k < 0) return res.sendStatus(502);
    const dsegs = segsOf(dpath.slice(k + PREFIX.length));
    const dst = resolve(user, dsegs);
    if (!dst || !dsegs.length) return res.sendStatus(409);
    const overwrite = (req.get('Overwrite') || 'T').toUpperCase() !== 'F';
    let dir, name = dsegs[dsegs.length - 1], created = true;
    if (dst.kind === 'missing') dir = dst.dir;
    else if (dst.kind === 'item') {
      if (!dst.dir) return res.sendStatus(403);
      dir = dst.dir;
      if (dst.item.id === r.item.id) { /* simple changement de casse */ }
      else {
        if (!overwrite) return res.sendStatus(412);
        if (!canEdit(dst.perm)) return res.sendStatus(403);
        trashItem(dst.item);
        created = false;
      }
    } else return res.sendStatus(403);
    if (!canEdit(dir.perm)) return res.sendStatus(403);
    if (isMove) {
      moveItem(user, r.item, { owner: dir.owner, parent: dir.parent }, name);
      log(r.item.id, user, 'move', 'WebDAV');
    } else {
      checkQuota(dir.owner, descendants(r.item.id).filter(d => !d.trashed_at).reduce((s, d) => s + d.size, 0));
      const c = copyTree(r.item, dir.parent, dir.owner, user, false, cleanName(name));
      log(c.id, user, 'copy', 'WebDAV');
    }
    res.sendStatus(created ? 201 : 204);
  }

  async function lock(req, res, user, segs, r) {
    const body = await readBody(req).catch(() => '');
    let status = 200;
    if (r.kind === 'missing') {
      if (!canEdit(r.dir.perm)) return res.sendStatus(403);
      const name = cleanName(r.name);
      const it = createItem({ owner: r.dir.owner, parent: r.dir.parent, type: 'file', name, size: 0, mimeType: mime.lookup(name) || 'application/octet-stream', by: user.name });
      fs.writeFileSync(fpath(it.id), '');
      indexer.enqueue(it.id);
      status = 201;
    } else if (!r || r.kind === undefined) return res.sendStatus(404);
    const prev = /<(opaquelocktoken:[^>]+)>/.exec(req.get('If') || '');
    const token = prev ? prev[1] : 'opaquelocktoken:' + crypto.randomUUID();
    const ownerXml = (/<(?:\w+:)?owner[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/.exec(body) || [])[1] || '';
    res.status(status).set({ 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` })
      .send(`<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth>${ownerXml ? `<d:owner>${ownerXml.replace(/<[^>]*>/g, '').trim() ? x(ownerXml.replace(/<[^>]*>/g, '').trim()) : ''}</d:owner>` : ''}<d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken><d:lockroot><d:href>${x(hrefOf(segs, false))}</d:href></d:lockroot></d:activelock></d:lockdiscovery></d:prop>`);
  }

  async function proppatch(req, res, user, segs, r) {
    const body = await readBody(req).catch(() => '');
    if (!r || r.kind === 'missing') return res.sendStatus(404);
    const ns = {};
    body.replace(/xmlns:(\w+)="([^"]*)"/g, (_, p, u) => { ns[p] = u; });
    const inner = (/<(?:\w+:)?prop>([\s\S]*?)<\/(?:\w+:)?prop>/g);
    const props = new Set(); let m;
    while ((m = inner.exec(body))) m[1].replace(/<(?:(\w+):)?([A-Za-z0-9_-]+)[\s>/]/g, (_, p, n) => { props.add(JSON.stringify([ns[p] || 'DAV:', n])); });
    const out = [...props].map(s => JSON.parse(s)).map(([u, n], i) => `<x${i}:${n} xmlns:x${i}="${x(u)}"/>`).join('');
    multistatus(res, [`<d:response><d:href>${x(hrefOf(segs, r.kind !== 'item' || r.item.type === 'folder'))}</d:href><d:propstat><d:prop>${out}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`]);
  }

  function getFile(req, res, user, segs, r) {
    if (r.kind === 'item' && r.item.type === 'file') {
      if (!fs.existsSync(fpath(r.item.id))) return res.sendStatus(404);
      return res.sendFile(fpath(r.item.id), { headers: { 'Content-Type': r.item.mime || 'application/octet-stream', ETag: `"${r.item.id}-${r.item.version}-${r.item.size}"`, 'Last-Modified': new Date(r.item.modified).toUTCString() }, lastModified: false, etag: false });
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>${x(C.APP_NAME)} — WebDAV</title><p>Dossier WebDAV. Ouvrez cette adresse dans l'explorateur de fichiers ou un client WebDAV.</p>`);
  }

  async function handler(req, res) {
    Object.entries(DAV_HEADERS).forEach(([k, v]) => res.set(k, v));
    if (req.method === 'OPTIONS') return res.status(200).set('Content-Length', '0').end();
    let user;
    try { user = authenticate(req); } catch (e) { return res.status(429).end(); }
    if (!user) return res.status(401).set('WWW-Authenticate', `Basic realm="${C.APP_NAME}", charset="UTF-8"`).end();
    const rawPath = (req.originalUrl.split('?')[0]).slice(PREFIX.length) || '/';
    const segs = segsOf(rawPath);
    const r = resolve(user, segs);
    const m = req.method;
    try {
      if (m === 'PROPFIND') { if (!r || r.kind === 'missing') return res.sendStatus(404); return await propfind(req, res, user, segs, r); }
      if (m === 'GET' || m === 'HEAD') { if (!r || r.kind === 'missing') return res.sendStatus(404); return getFile(req, res, user, segs, r); }
      if (m === 'PUT') { if (!r) return res.sendStatus(409); return await put(req, res, user, segs, r); }
      if (m === 'MKCOL') {
        if (!r) return res.sendStatus(409);
        if (r.kind !== 'missing') return res.sendStatus(405);
        if (!canEdit(r.dir.perm)) return res.sendStatus(403);
        createItem({ owner: r.dir.owner, parent: r.dir.parent, type: 'folder', name: cleanName(r.name), by: user.name });
        return res.sendStatus(201);
      }
      if (m === 'DELETE') {
        if (!r || r.kind === 'missing') return res.sendStatus(404);
        if (r.kind !== 'item') return res.sendStatus(403);
        if (!r.dir) { db.prepare('DELETE FROM access WHERE item_id=? AND user_id=?').run(r.item.id, user.id); return res.sendStatus(204); }
        if (!canEdit(r.perm)) return res.sendStatus(403);
        trashItem(r.item); log(r.item.id, user, 'trash', 'WebDAV');
        return res.sendStatus(204);
      }
      if (m === 'MOVE' || m === 'COPY') { if (!r || r.kind === 'missing') return res.sendStatus(404); return await moveOrCopy(req, res, user, segs, r, m === 'MOVE'); }
      if (m === 'LOCK') { if (!r) return res.sendStatus(409); return await lock(req, res, user, segs, r); }
      if (m === 'UNLOCK') return res.sendStatus(204);
      if (m === 'PROPPATCH') return await proppatch(req, res, user, segs, r);
      return res.sendStatus(405);
    } catch (e) {
      const st = e.status || 500;
      if (st >= 500) console.error('[WebDAV]', m, rawPath, e);
      if (!res.headersSent) res.status(st === 413 ? 507 : st).set('Content-Type', 'text/plain; charset=utf-8').send(e.message);
    }
  }

  app.use(PREFIX, (req, res) => { handler(req, res); });
  // Certains clients (Windows) sondent la racine du site avant de monter le lecteur
  app.options('/', (req, res) => { Object.entries(DAV_HEADERS).forEach(([k, v]) => res.set(k, v)); res.sendStatus(200); });
};
