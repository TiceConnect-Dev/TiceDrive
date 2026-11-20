'use strict';
/* ============================== État ============================== */
const S = {
  me: null, view: 'drive', folder: 'root', items: [], path: [], perm: 'owner', root: 'drive', folderInfo: null, quick: null, admin: null,
  layout: 'grid', sort: 'name', dir: 1, q: '', sel: new Set(), lastClick: null, details: false, detailTab: 'info', loading: true, clip: null,
};
try { Object.assign(S, JSON.parse(localStorage.getItem('ed-prefs') || '{}')); } catch (e) { }
const savePrefs = () => { try { localStorage.setItem('ed-prefs', JSON.stringify({ layout: S.layout, sort: S.sort, dir: S.dir, details: S.details })); } catch (e) { } };
const canEdit = p => p === 'owner' || p === 'edit';
const byId = id => S.items.find(i => i.id === id) || S.quick?.find(i => i.id === id);
const TITLES = { drive: 'Mon espace', recent: 'Récents', starred: 'Favoris', shared: 'Partagés avec moi', links: 'Mes partages', trash: 'Corbeille', admin: 'Administration' };
const NAV = [
  ['drive', 'Mon espace', P.home], ['recent', 'Récents', P.recent], ['starred', 'Favoris', P.star], 'sep',
  ['shared', 'Partagés avec moi', P.people], ['links', 'Mes partages', P.link], 'sep', ['trash', 'Corbeille', P.trash],
];
const writable = () => S.view === 'drive' && !S.q && canEdit(S.perm);
const targetFolder = () => (writable() ? S.folder : 'root');

/* ============================== Chargement ============================== */
async function refreshMe() {
  try {
    const m = await api('api/me');
    S.me = m;
    Uploader.chunk = m.chunkSize || 0;
    $('#appName').textContent = m.appName; document.title = m.appName;
    $('#userName').textContent = m.user.name; $('#userAv').textContent = initials(m.user.name);
    renderNav(); renderQuota();
  } catch (e) { }
}
async function load(keepSel) {
  S.loading = true;
  if (!keepSel) { S.sel.clear(); renderBody(); }
  try {
    if (S.q) { S.items = (await api('api/search?q=' + encodeURIComponent(S.q))).items; S.perm = 'view'; S.path = []; S.quick = null; }
    else if (S.view === 'drive') {
      const r = await api('api/folder/' + S.folder);
      Object.assign(S, { items: r.items, path: r.path, perm: r.perm, root: r.root, team: r.team, folderInfo: r.folder });
      S.quick = S.folder === 'root' ? (await api('api/view/recent')).items.slice(0, 6) : null;
    }
    else if (S.view === 'admin') { const [u, t] = await Promise.all([api('api/admin/users'), api('api/admin/teams')]); S.admin = { ...u, teams: t }; }
    else { S.items = (await api('api/view/' + S.view)).items; S.quick = null; }
  } catch (e) {
    toast(e.message, 'err');
    if (S.view === 'drive' && S.folder !== 'root' && (e.status === 404 || e.status === 403)) { S.loading = false; return go(''); }
    S.items = [];
  }
  S.loading = false;
  [...S.sel].forEach(id => { if (!S.items.find(i => i.id === id)) S.sel.delete(id); });
  render();
}
const reload = () => { load(true); refreshMe(); };

/* ============================== Navigation ============================== */
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  S.q = ''; $('#q').value = '';
  if (h.startsWith('f-')) { S.view = 'drive'; S.folder = h.slice(2); }
  else if (h.startsWith('t-')) { S.view = 'drive'; S.folder = 'team:' + h.slice(2); }
  else if (TITLES[h]) { S.view = h; if (h === 'drive') S.folder = 'root'; }
  else { S.view = 'drive'; S.folder = 'root'; }
  $('#side').classList.remove('open');
  hideMenus();
  S.items = []; S.quick = null; S.path = [];
  load();
  $('#content').scrollTop = 0;
}
function go(h) { if (location.hash.slice(1) === h || (!h && !location.hash)) route(); else location.hash = h; }
const openFolder = id => go(id && id !== 'root' ? 'f-' + id : '');
window.addEventListener('hashchange', route);

/* ============================== Rendu ============================== */
function renderNav() {
  const isAdmin = S.me?.user.role === 'admin';
  const teams = S.me?.teams || [];
  const list = NAV.slice();
  if (teams.length) list.splice(4, 0, ['label', "Espaces d'équipe"], ...teams.map(t => ['t-' + t.id, t.name, P.team]), 'sep');
  if (isAdmin) list.push('sep', ['admin', 'Administration', P.admin]);
  const active = v => !S.q && (v.startsWith('t-') ? S.view === 'drive' && S.root === 'team' && S.team?.id === v.slice(2) : v === 'drive' ? S.view === 'drive' && S.root === 'drive' : S.view === v || (v === 'shared' && S.view === 'drive' && S.root === 'shared'));
  $('#nav').innerHTML = list.map(n => n === 'sep' ? '<li class="nav-sep" role="separator"></li>' : n[0] === 'label' ? `<li class="nav-label">${esc(n[1])}</li>` :
    `<li><button data-v="${n[0]}" class="${active(n[0]) ? 'on' : ''}" ${active(n[0]) ? 'aria-current="page"' : ''}>${SVG(n[2])}<span class="nl">${esc(n[1])}</span></button></li>`).join('');
  $$('#nav [data-v]').forEach(b => b.onclick = () => go(b.dataset.v === 'drive' ? '' : b.dataset.v));
}
function renderQuota() {
  const m = S.me; if (!m) return;
  const q = m.quota, u = m.used, pct = q ? Math.min(100, u / q * 100) : 0;
  const b = m.breakdown, total = q || Math.max(u, 1);
  const seg = [['documents', '#2457d6'], ['images', '#8b3d85'], ['videos', '#a3243a'], ['audio', '#b34000'], ['archives', '#6e4f3a'], ['autres', '#929292'], ['versions', '#c3c3c3']];
  $('#quota').className = 'quota' + (q && pct > 95 ? ' full' : '');
  $('#quota').innerHTML = `<h4><span>Stockage</span><span>${q ? Math.round(pct) + ' %' : ''}</span></h4>
    <div class="qbar" title="${seg.filter(s => b[s[0]]).map(s => s[0] + ' : ' + fmtSize(b[s[0]])).join('\n')}">${seg.map(([k, c]) => `<i style="width:${b[k] / total * 100}%;background:${c}"></i>`).join('')}</div>
    <p>${fmtSize(u)} utilisés${q ? ' sur ' + fmtSize(q) : ' (illimité)'}</p>`;
}
function render() {
  renderNav();
  // Fil d'Ariane et titre
  const cr = $('#crumbs'), t = $('#title');
  let title = TITLES[S.view];
  if (S.q) { cr.innerHTML = `<li><a data-go="">Mon espace</a></li><li><a>Recherche</a></li>`; title = `Résultats pour « ${S.q} »`; }
  else if (S.view === 'drive') {
    const team = S.root === 'team' && S.team;
    const rootLbl = team ? team.name : S.root === 'shared' ? 'Partagés avec moi' : 'Mon espace', rootGo = team ? 't-' + team.id : S.root === 'shared' ? 'shared' : '';
    const rootDrop = team ? `data-drop="team:${team.id}"` : S.root === 'drive' ? 'data-drop="root"' : '';
    cr.innerHTML = (team ? `<li><a>Espaces d'équipe</a></li>` : '') + `<li><a data-go="${rootGo}" ${rootDrop}>${esc(rootLbl)}</a></li>` + S.path.map(f => `<li><a data-go="f-${f.id}" data-drop="${f.id}">${esc(f.name)}</a></li>`).join('');
    if (S.path.length) title = S.path[S.path.length - 1].name; else if (team) title = team.name;
  } else cr.innerHTML = `<li><a data-go="">Accueil</a></li><li><a>${TITLES[S.view]}</a></li>`;
  $$('#crumbs [data-go]').forEach(a => a.onclick = () => go(a.dataset.go));
  const ROLE_L = { manager: 'Responsable', member: 'Membre', reader: 'Lecteur' };
  const permTag = S.view !== 'drive' || S.q ? '' : S.root === 'team' && S.team ? `<span class="tag ${S.team.role === 'reader' ? 'grey' : ''}">${ROLE_L[S.team.role]}</span>`
    : S.perm !== 'owner' ? `<span class="tag ${S.perm === 'edit' ? '' : 'grey'}">${S.perm === 'edit' ? 'Modification' : 'Lecture seule'}</span>` : '';
  const teamBtn = S.view === 'drive' && !S.q && S.root === 'team' && S.team && !S.path.length ? `<button class="btn btn-tertiary btn-sm" id="teamBtn">${SVG(P.people, 16)}Membres</button>` : '';
  t.innerHTML = `<span>${esc(title)}</span>${permTag}${teamBtn}`;
  $('#teamBtn') && ($('#teamBtn').onclick = () => teamDlg(S.team.id, false));
  $('#tools').style.visibility = S.view === 'admin' ? 'hidden' : '';
  $('#sort').value = S.sort;
  $('#sortDir').innerHTML = SVG(P.sort); $('#sortDir').style.transform = S.dir < 0 ? 'scaleY(-1)' : '';
  $('#vGrid').innerHTML = SVG(P.grid); $('#vList').innerHTML = SVG(P.list);
  $('#vGrid').classList.toggle('on', S.layout === 'grid'); $('#vList').classList.toggle('on', S.layout === 'list');
  $('#infoBtn').innerHTML = SVG(P.info, 22); $('#infoBtn').classList.toggle('on', S.details);
  $('#themeBtn').innerHTML = SVG(P.moon);
  // Bandeau
  const bn = $('#banner');
  if (S.view === 'trash' && !S.q) bn.innerHTML = `<div class="alert" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span style="flex:1">Les éléments de la corbeille sont supprimés définitivement au bout de ${S.me?.trashDays || 30} jours.</span>${S.items.length ? '<button class="btn btn-secondary btn-sm" id="emptyTrash">Vider la corbeille</button>' : ''}</div>`;
  else if (S.view === 'drive' && S.perm === 'view' && !S.q) bn.innerHTML = `<div class="alert">${S.root === 'team' ? 'Vous êtes lecteur dans cet espace : vous pouvez consulter et télécharger, mais pas modifier.' : 'Ce dossier est partagé avec vous en lecture seule.'}</div>`;
  else if (S.view === 'drive' && !S.q && S.root === 'team' && S.team && !S.path.length && S.team.quota) bn.innerHTML = `<div class="team-quota"><span class="sub">Espace utilisé : ${fmtSize(S.team.used)} / ${fmtSize(S.team.quota)}</span><div class="mini-bar" style="flex:1;max-width:240px"><i style="width:${Math.min(100, S.team.used / S.team.quota * 100)}%"></i></div></div>`;
  else bn.innerHTML = '';
  $('#emptyTrash') && ($('#emptyTrash').onclick = emptyTrash);
  renderBody();
  renderSelbar();
  renderDetails();
}

function sorted(list) {
  if ((S.view === 'recent' && !S.q)) return list;
  const k = S.sort, d = S.dir;
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    let r = 0;
    if (k === 'name') r = a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' });
    else if (k === 'modified') r = a.modified - b.modified;
    else if (k === 'size') r = (a.size || 0) - (b.size || 0) || a.name.localeCompare(b.name, 'fr');
    else if (k === 'type') r = KIND[kind(a)].l.localeCompare(KIND[kind(b)].l) || a.name.localeCompare(b.name, 'fr');
    return r * d;
  });
}
const visible = () => (S.view === 'admin' ? [] : sorted(S.items));

function renderBody() {
  const c = $('#content');
  if (S.loading && !S.items.length) { c.innerHTML = '<div class="loading"><span class="spin"></span></div>'; return; }
  if (S.view === 'admin' && !S.q) return renderAdmin(c);
  const list = visible();
  let html = '';
  if (S.quick?.length && S.view === 'drive' && S.folder === 'root' && !S.q && S.root === 'drive') {
    html += `<div class="section-t">Accès rapide</div><div class="quick">${S.quick.map(it => `<button class="qc" data-quick="${it.id}">${icon(it, 32)}<div><div class="name">${esc(it.name)}</div><div class="sub">${fmtDate(it.modified)}${it.modified_by ? ' · ' + esc(it.modified_by) : ''}</div></div></button>`).join('')}</div>`;
  }
  if (!list.length) html += emptyHTML();
  else if (S.layout === 'grid' && !S.q) {
    const folders = list.filter(i => i.type === 'folder'), files = list.filter(i => i.type !== 'folder');
    if (folders.length) html += `<div class="section-t">Dossiers <span class="tag grey">${folders.length}</span></div><div class="grid folders">${folders.map(cardHTML).join('')}</div>`;
    if (files.length) html += `<div class="section-t">Fichiers <span class="tag grey">${files.length}</span></div><div class="grid">${files.map(cardHTML).join('')}</div>`;
  } else {
    const ar = k => (S.sort === k ? (S.dir > 0 ? ' ▲' : ' ▼') : '');
    const showLoc = S.q || ['recent', 'starred', 'shared', 'links', 'trash'].includes(S.view);
    if (S.q) html += `<p class="sub" style="margin:4px 0 10px">${list.length} résultat${list.length > 1 ? 's' : ''} — recherche dans les noms, descriptions et le contenu des documents</p>`;
    html += `<table class="list"><thead><tr><th class="c-chk"><input type="checkbox" id="chkAll" aria-label="Tout sélectionner" ${S.sel.size && S.sel.size === list.length ? 'checked' : ''}></th><th data-s="name">Nom${ar('name')}</th>${S.view === 'shared' ? '<th class="hide-m c-own">Propriétaire</th>' : ''}<th class="hide-m c-mod col-mod" data-s="modified">${S.view === 'trash' ? 'Supprimé' : 'Modifié'}${ar('modified')}</th><th class="hide-m c-size col-size" data-s="size">Taille${ar('size')}</th><th class="hide-m c-type col-type" data-s="type">Type${ar('type')}</th><th class="c-more"></th></tr></thead><tbody>${list.map(it => rowHTML(it, showLoc)).join('')}</tbody></table>`;
  }
  c.innerHTML = html;
  c.classList.toggle('selecting', S.sel.size > 0);
  if ($('#chkAll')) $('#chkAll').onchange = e => { S.sel = e.target.checked ? new Set(list.map(i => i.id)) : new Set(); render(); };
  $$('th[data-s]', c).forEach(th => th.onclick = () => { if (S.sort === th.dataset.s) S.dir *= -1; else { S.sort = th.dataset.s; S.dir = 1; } savePrefs(); render(); });
  $$('[data-quick]', c).forEach(b => { b.onclick = () => openItem(byId(b.dataset.quick)); b.oncontextmenu = e => { e.preventDefault(); S.sel = new Set([b.dataset.quick]); showCtx(b.dataset.quick, e.clientX, e.clientY); }; });
  $$('[data-act]', c).forEach(b => b.onclick = () => ({ upload: () => $('#fileIn').click(), newFolder })[b.dataset.act]());
  bindItems();
}
function emptyHTML() {
  if (S.q) return emptyBox(P.search, 'Aucun résultat', 'Vérifiez l\'orthographe ou essayez un autre terme.');
  const m = {
    drive: [P.cloud, S.folder === 'root' ? 'Votre espace est vide' : 'Ce dossier est vide', canEdit(S.perm) ? 'Glissez-déposez des fichiers ou des dossiers ici, ou utilisez le bouton « Nouveau ».' : 'Aucun élément pour le moment.'],
    recent: [P.recent, 'Aucun fichier récent', 'Les fichiers que vous envoyez ou modifiez apparaîtront ici.'],
    starred: [P.star, 'Aucun favori', 'Ajoutez un élément aux favoris pour le retrouver ici.'],
    shared: [P.people, 'Rien n\'a été partagé avec vous', 'Les dossiers et fichiers que d\'autres utilisateurs partagent avec vous apparaîtront ici.'],
    links: [P.link, 'Aucun partage', 'Les éléments que vous partagez (personnes ou liens) apparaîtront ici.'],
    trash: [P.trash, 'La corbeille est vide', 'Les éléments supprimés apparaîtront ici.'],
  }[S.view];
  return emptyBox(m[0], m[1], m[2], S.view === 'drive' && canEdit(S.perm) ? `<button class="btn btn-primary" data-act="upload">${SVG(P.upload)}Envoyer des fichiers</button> <button class="btn btn-secondary" data-act="newFolder">${SVG(P.newFolder)}Nouveau dossier</button>` : '');
}
const emptyBox = (ic, h, p, extra = '') => `<div class="empty"><div class="ill">${SVG(ic, 56)}</div><h2>${h}</h2><p>${p}</p>${extra ? `<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">${extra}</div>` : ''}</div>`;
const moreBtn = (id, cls = 'more') => `<button class="btn-icon ${cls}" data-more="${id}" title="Plus d'actions" aria-label="Plus d'actions">${SVG(P.more)}</button>`;
const badges = it => `<span class="badges">${it.comments ? `<span class="cmt" title="${it.comments} commentaire(s)">${SVG(P.comment, 15)}${it.comments}</span>` : ''}${it.shared ? `<span class="shr" title="Partagé">${SVG(P.people, 16)}</span>` : ''}${it.starred ? `<span class="star" title="Favori">${SVG(P.star, 16)}</span>` : ''}</span>`;
const dot = it => (it.color && it.type !== 'folder' ? `<span class="cdot" style="background:${COLOR_HEX[it.color]}" title="${COLOR_L[it.color]}"></span>` : '');
const isCut = id => S.clip?.ids.includes(id) ? ' cut' : '';
function cardHTML(it) {
  const sel = S.sel.has(it.id) ? ' sel' : '';
  if (it.type === 'folder') return `<div class="card folder${sel}${isCut(it.id)}" data-id="${it.id}" draggable="true" tabindex="0"><label class="chkw" title="Sélectionner"><input type="checkbox" class="chk" ${sel ? 'checked' : ''} tabindex="-1" aria-label="Sélectionner « ${esc(it.name)} »"></label>${icon(it, 30)}<div class="meta"><span class="name" title="${esc(it.name)}">${esc(it.name)}</span><span class="sub">${S.view === 'shared' ? 'Par ' + esc(it.owner_name) : it.children + ' élément' + (it.children > 1 ? 's' : '')}</span></div>${badges(it)}${moreBtn(it.id)}</div>`;
  const k = kind(it);
  const th = k === 'image' ? `<img src="api/items/${it.id}/raw?v=${it.version}" alt="" loading="lazy" onerror="this.replaceWith(document.createRange().createContextualFragment(icon({type:'file',name:'x.png'},64)))">` : icon(it, 64);
  const sub = S.view === 'trash' ? 'Supprimé ' + fmtDate(it.trashed_at).toLowerCase() : S.view === 'shared' ? 'Par ' + esc(it.owner_name) : fmtDate(it.modified) + ' · ' + fmtSize(it.size);
  return `<div class="card${sel}${isCut(it.id)}" data-id="${it.id}" draggable="true" tabindex="0" ${it.color ? `style="border-top:3px solid ${COLOR_HEX[it.color]}"` : ''}><label class="chkw" title="Sélectionner"><input type="checkbox" class="chk" ${sel ? 'checked' : ''} tabindex="-1" aria-label="Sélectionner « ${esc(it.name)} »"></label><div class="thumb">${th}</div><div class="meta">${icon(it, 20)}<span class="name" title="${esc(it.name)}">${esc(it.name)}</span>${badges(it)}</div><div class="sub">${sub}</div>${moreBtn(it.id)}</div>`;
}
function rowHTML(it, showLoc) {
  const sel = S.sel.has(it.id);
  return `<tr class="row${sel ? ' sel' : ''}${isCut(it.id)}" data-id="${it.id}" draggable="true" tabindex="0"><td class="c-chk"><label class="chkw" title="Sélectionner"><input type="checkbox" class="chk" ${sel ? 'checked' : ''} tabindex="-1" aria-label="Sélectionner « ${esc(it.name)} »"></label></td>
    <td class="n"><div>${icon(it, 26)}<div style="min-width:0;flex:1"><div class="name">${dot(it)}${esc(it.name)}</div>${showLoc && it.location ? `<div class="sub">${esc(it.location)}</div>` : ''}${it.snippet ? `<div class="snip">${esc(it.snippet).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>')}</div>` : ''}</div>${badges(it)}</div></td>
    ${S.view === 'shared' ? `<td class="hide-m sub">${esc(it.owner_name)}</td>` : ''}
    <td class="hide-m sub col-mod">${fmtDate(S.view === 'trash' ? it.trashed_at : it.modified)}${it.modified_by && S.view !== 'trash' ? ' · ' + esc(it.modified_by) : ''}</td>
    <td class="hide-m sub col-size">${it.type === 'folder' ? it.children + ' élément' + (it.children > 1 ? 's' : '') : fmtSize(it.size)}</td>
    <td class="hide-m sub col-type">${KIND[kind(it)].l}${it.ext ? ' · ' + it.ext.toUpperCase() : ''}</td>
    <td>${moreBtn(it.id, 'list-more')}</td></tr>`;
}

function bindItems() {
  $$('#content [data-id]').forEach(el => {
    const id = el.dataset.id, it = byId(id);
    let longPress = null, suppressClick = false;
    el.onclick = e => {
      if (e.target.closest('[data-more]')) return;
      if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
      if (e.target.closest('.chkw')) { e.preventDefault(); toggleSel(id); return; }
      if (e.shiftKey && S.lastClick) {
        const ids = visible().map(i => i.id), a = ids.indexOf(S.lastClick), b = ids.indexOf(id);
        if (a >= 0 && b >= 0) { ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => S.sel.add(x)); render(); return; }
      }
      // Ctrl/Cmd+clic, mode sélection en cours ou corbeille : on sélectionne ; sinon on ouvre
      if (e.ctrlKey || e.metaKey || S.sel.size > 0 || S.view === 'trash') { toggleSel(id); return; }
      openItem(it);
    };
    // Appui long (mobile) : sélection
    el.addEventListener('touchstart', () => { longPress = setTimeout(() => { suppressClick = true; navigator.vibrate?.(30); toggleSel(id); }, 500); }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(ev => el.addEventListener(ev, () => clearTimeout(longPress), { passive: true }));
    el.onkeydown = e => { if (e.key === 'Enter') openItem(it); if (e.key === ' ') { e.preventDefault(); toggleSel(id); } };
    el.oncontextmenu = e => { e.preventDefault(); clearTimeout(longPress); showCtx(id, e.clientX, e.clientY); };
    const mb = $('[data-more]', el);
    if (mb) mb.onclick = e => { e.stopPropagation(); const r = mb.getBoundingClientRect(); showCtx(id, r.right - 240, r.bottom + 4); };
    if (S.view !== 'trash') {
      el.ondragstart = e => { if (!S.sel.has(id)) { S.sel = new Set([id]); renderSelbar(); } e.dataTransfer.setData('text/x-ed', JSON.stringify([...S.sel])); e.dataTransfer.effectAllowed = 'move'; };
      if (it?.type === 'folder' && S.view === 'drive') dropTarget(el, id);
    }
  });
  $$('#crumbs [data-drop]').forEach(a => dropTarget(a, a.dataset.drop));
}
function dropTarget(el, fid) {
  el.ondragover = e => { if (e.dataTransfer.types.includes('text/x-ed') || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); } };
  el.ondragleave = () => el.classList.remove('drop');
  el.ondrop = async e => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove('drop'); hideDropzone();
    const raw = e.dataTransfer.getData('text/x-ed');
    if (raw) {
      const ids = JSON.parse(raw).filter(x => x !== fid);
      if (!ids.length) return;
      try { const r = await api('api/move', { body: { ids, target: fid } }); if (r.moved) toast(`${r.moved} élément${r.moved > 1 ? 's' : ''} déplacé${r.moved > 1 ? 's' : ''}`, 'ok'); S.sel.clear(); reload(); }
      catch (err) { toast(err.message, 'err'); }
    } else uploadList(await filesFromDrop(e.dataTransfer), fid);
  };
}
function toggleSel(id) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); S.lastClick = id; render(); }
function clearSel() { if (!S.sel.size) return; S.sel.clear(); render(); }

function renderSelbar() {
  const n = S.sel.size, b = $('#selbar');
  b.classList.toggle('show', n > 0);
  if (!n) return;
  const trash = S.view === 'trash';
  const all = visible().length;
  b.innerHTML = `<label class="chkw" style="opacity:1" title="Tout sélectionner"><input type="checkbox" class="chk" id="selAll" ${n === all ? 'checked' : ''}></label><span>${n} élément${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}</span>${n < all ? `<button class="btn-link" id="selAllBtn" style="font-weight:500;font-size:14px">Tout sélectionner (${all})</button>` : ''}<span class="sp"></span>` + (n === 1 && !trash ? `<button class="btn btn-tertiary btn-sm" data-b="open">${SVG(P.open, 16)}<span class="hide-m">Ouvrir</span></button>${byId([...S.sel][0])?.perm === 'owner' ? `<button class="btn btn-tertiary btn-sm" data-b="share">${SVG(P.share, 16)}<span class="hide-m">Partager</span></button>` : ''}<button class="btn btn-tertiary btn-sm" data-b="rename">${SVG(P.edit, 16)}<span class="hide-m">Renommer</span></button>` : '') + (trash
    ? `<button class="btn btn-tertiary btn-sm" data-b="restore">${SVG(P.restore, 16)}Restaurer</button><button class="btn btn-danger btn-sm" data-b="purge">Supprimer définitivement</button>`
    : `<button class="btn btn-tertiary btn-sm" data-b="download">${SVG(P.dl, 16)}<span class="hide-m">Télécharger</span></button><button class="btn btn-tertiary btn-sm" data-b="move">${SVG(P.move, 16)}<span class="hide-m">Déplacer</span></button><button class="btn btn-tertiary btn-sm" data-b="copy">${SVG(P.copy, 16)}<span class="hide-m">Copier</span></button><button class="btn btn-tertiary btn-sm" data-b="star">${SVG(P.star, 16)}<span class="hide-m">Favoris</span></button><button class="btn btn-tertiary btn-sm" data-b="delete" style="color:var(--red)">${SVG(P.trash, 16)}<span class="hide-m">Supprimer</span></button>`)
    + `<button class="btn-icon" data-b="clear" title="Annuler la sélection">${SVG(P.close, 18)}</button>`;
  $$('[data-b]', b).forEach(x => x.onclick = () => {
    const a = x.dataset.b, one = byId([...S.sel][0]);
    if (a === 'clear') clearSel(); else if (a === 'open') openItem(one); else if (a === 'share') shareDlg(one); else if (a === 'rename') renameDlg(one); else bulk(a);
  });
  $('#selAll').onchange = e => { S.sel = e.target.checked ? new Set(visible().map(i => i.id)) : new Set(); render(); };
  $('#selAllBtn') && ($('#selAllBtn').onclick = () => { S.sel = new Set(visible().map(i => i.id)); render(); });
}

/* ============================== Panneau de détails ============================== */
let detailsToken = 0;
async function renderDetails() {
  const d = $('#details');
  d.classList.toggle('show', S.details && S.view !== 'admin');
  if (!S.details || S.view === 'admin') return;
  const head = `<div class="dt-h"><span class="tag">Détails</span><button class="btn-icon" id="dtClose" title="Fermer le panneau">${SVG(P.close)}</button></div>`;
  const tok = ++detailsToken;
  if (S.sel.size !== 1) {
    const n = S.sel.size;
    if (n > 1) {
      const items = [...S.sel].map(byId).filter(Boolean);
      d.innerHTML = head + `<div class="dt-b"><div class="prev" style="margin-top:12px">${SVG(P.copy, 56)}</div><h3>${n} éléments sélectionnés</h3><dl class="props"><dt>Fichiers</dt><dd>${items.filter(i => i.type === 'file').length}</dd><dt>Dossiers</dt><dd>${items.filter(i => i.type === 'folder').length}</dd><dt>Taille des fichiers</dt><dd>${fmtSize(items.reduce((s, i) => s + (i.type === 'file' ? i.size : 0), 0))}</dd></dl></div>`;
    } else if (S.view === 'drive' && S.folder !== 'root' && S.folderInfo) {
      d.innerHTML = head + '<div class="dt-b"><div class="loading"><span class="spin"></span></div></div>';
      return fillDetails(S.folderInfo.id, tok, head);
    } else d.innerHTML = head + `<div class="dt-b"><div class="empty" style="padding:40px 0"><div class="ill" style="width:90px;height:90px">${SVG(P.info, 40)}</div><p>Sélectionnez un fichier ou un dossier pour afficher ses détails, son activité et ses versions.</p></div></div>`;
    $('#dtClose').onclick = toggleDetails;
    return;
  }
  d.innerHTML = head + '<div class="dt-b"><div class="loading"><span class="spin"></span></div></div>';
  $('#dtClose').onclick = toggleDetails;
  fillDetails([...S.sel][0], tok, head);
}
async function fillDetails(id, tok, head) {
  const d = $('#details');
  let it;
  try { it = await api('api/items/' + id); } catch (e) { if (tok === detailsToken) d.innerHTML = head + `<div class="dt-b"><p class="sub">${esc(e.message)}</p></div>`; return; }
  if (tok !== detailsToken) return;
  const k = kind(it), tab = S.detailTab;
  const tabs = [['info', 'Infos'], ['comments', 'Commentaires' + (it.comments ? ` (${it.comments})` : '')], ['activity', 'Activité']].concat(it.type === 'file' ? [['versions', 'Versions']] : []);
  const cur = tabs.find(t => t[0] === tab) ? tab : 'info';
  d.innerHTML = head + `<div class="dt-b">
    <div class="prev" style="margin-top:12px">${k === 'image' ? `<img src="api/items/${it.id}/raw?v=${it.version}" alt="">` : icon(it, 72)}</div>
    <h3>${esc(it.name)}</h3>
    <div style="display:flex;gap:6px;flex-wrap:wrap"><span class="tag grey">${KIND[k].l}</span>${it.perm !== 'owner' ? `<span class="tag">${it.perm === 'edit' ? 'Modification' : 'Lecture seule'}</span>` : ''}${it.shared ? '<span class="tag">Partagé</span>' : ''}${it.trashed_at ? '<span class="tag red">Corbeille</span>' : ''}</div>
    <div class="tabs" role="tablist">${tabs.map(t => `<button role="tab" data-tab="${t[0]}" class="${t[0] === cur ? 'on' : ''}">${t[1]}</button>`).join('')}</div>
    <div id="dtTab"></div></div>`;
  $('#dtClose').onclick = toggleDetails;
  $$('[data-tab]', d).forEach(b => b.onclick = () => { S.detailTab = b.dataset.tab; fillDetails(id, ++detailsToken, head); });
  const box = $('#dtTab');
  if (cur === 'info') {
    box.innerHTML = `<dl class="props">
      <dt>Taille</dt><dd>${it.type === 'folder' ? fmtSize(it.totalSize) + ' · ' + it.count + ' élément(s)' : fmtSize(it.size)}</dd>
      <dt>Emplacement</dt><dd>${esc(it.location)}</dd>
      <dt>Propriétaire</dt><dd>${it.mine ? 'Moi' : esc(it.owner_name)}</dd>
      <dt>Modifié</dt><dd>${fmtFull(it.modified)}${it.modified_by ? ' par ' + esc(it.modified_by) : ''}</dd>
      <dt>Créé</dt><dd>${fmtFull(it.created)}</dd>
      ${it.type === 'file' ? `<dt>Version</dt><dd>${it.version}</dd>` : ''}
      <dt>Description</dt><dd style="font-weight:400">${it.description ? esc(it.description).replace(/\n/g, '<br>') : '<span class="sub">Aucune</span>'} ${canEdit(it.perm) && !it.trashed_at ? '<button class="btn-link" id="dtDesc" style="font-size:13px">Modifier</button>' : ''}</dd>
    </dl>
    <div class="acts">${it.trashed_at ? (it.perm === 'owner' ? `<button class="btn btn-secondary btn-sm" data-a="restore">${SVG(P.restore, 16)}Restaurer</button><button class="btn btn-danger btn-sm" data-a="purge">Supprimer définitivement</button>` : '') :
      `<button class="btn btn-primary btn-sm" data-a="open">${SVG(P.open, 16)}Ouvrir</button>${it.perm === 'owner' && !it.team ? `<button class="btn btn-secondary btn-sm" data-a="share">${SVG(P.share, 16)}Partager</button>` : ''}<button class="btn btn-tertiary btn-sm" data-a="download">${SVG(P.dl, 16)}Télécharger</button>`}</div>`;
    $$('[data-a]', box).forEach(b => b.onclick = () => act(b.dataset.a, it));
    $('#dtDesc') && ($('#dtDesc').onclick = () => descDlg(it));
  } else if (cur === 'comments') {
    box.innerHTML = '<div class="loading"><span class="spin"></span></div>';
    const list = await api(`api/items/${id}/comments`).catch(() => []);
    box.innerHTML = `<ul class="comments">${list.map(c => `<li><div class="ch"><span class="av" style="width:28px;height:28px;font-size:11px">${esc(initials(c.user_name))}</span><b>${esc(c.user_name)}</b><span class="sub">${fmtDate(c.created)}</span>${c.canDelete ? `<button class="btn-icon" data-cdel="${c.id}" title="Supprimer" style="margin-left:auto;padding:4px">${SVG(P.close, 14)}</button>` : ''}</div><div class="ct">${esc(c.text).replace(/\n/g, '<br>')}</div></li>`).join('') || '<li class="sub" style="border:none">Aucun commentaire pour le moment.</li>'}</ul>
      <form id="cform" style="margin-top:12px"><div class="field" style="margin-bottom:8px"><label for="ctext" class="sr">Commentaire</label><textarea id="ctext" rows="3" placeholder="Ajouter un commentaire…"></textarea></div><button class="btn btn-primary btn-sm">Publier</button></form>`;
    $('#cform').onsubmit = async e => { e.preventDefault(); const v = $('#ctext').value.trim(); if (!v) return; try { await api(`api/items/${id}/comments`, { body: { text: v } }); fillDetails(id, ++detailsToken, head); load(true); } catch (err) { toast(err.message, 'err'); } };
    $('#ctext').onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('#cform').requestSubmit(); };
    $$('[data-cdel]', box).forEach(b => b.onclick = async () => { await api('api/comments/' + b.dataset.cdel, { method: 'DELETE' }).catch(e => toast(e.message, 'err')); fillDetails(id, ++detailsToken, head); load(true); });
  } else if (cur === 'activity') {
    box.innerHTML = '<div class="loading"><span class="spin"></span></div>';
    const acts = await api(`api/items/${id}/activity`).catch(() => []);
    if (tok !== detailsToken && tok + 1 !== detailsToken) { }
    const L = { comment: 'a commenté', extract: 'a extrait l\'archive', upload: 'a envoyé', create: 'a créé', rename: 'a renommé', move: 'a déplacé vers', trash: 'a placé dans la corbeille', restore: 'a restauré', edit: 'a modifié', copy: 'a créé une copie de', share: 'a partagé avec', link: 'a créé un lien de partage', download: 'a téléchargé', open: 'a ouvert', version: 'a restauré une version' };
    const LM = { view: '(lecture)', edit: '(modification)', upload: '(dépôt)' };
    box.innerHTML = acts.length ? `<ul class="timeline">${acts.map(a => `<li><b>${esc(a.user_name || 'Système')}</b> ${L[a.action] || a.action}${a.detail ? ' <span class="sub" style="white-space:normal">' + esc(a.action === 'link' ? LM[a.detail] || a.detail : a.detail) + '</span>' : ''}<div class="sub">${fmtFull(a.at)}</div></li>`).join('')}</ul>` : '<p class="sub" style="margin-top:16px">Aucune activité enregistrée.</p>';
  } else {
    box.innerHTML = '<div class="loading"><span class="spin"></span></div>';
    const v = await api(`api/items/${id}/versions`);
    box.innerHTML = `<ul class="vlist"><li class="cur">${SVG(P.check, 18)}<div><b>Version ${v.current.version} (actuelle)</b><div class="sub">${fmtFull(v.current.modified)}${v.current.author ? ' · ' + esc(v.current.author) : ''} · ${fmtSize(v.current.size)}</div></div></li>
      ${v.versions.map(x => `<li>${SVG(P.history, 18)}<div><b>Version ${x.version}</b><div class="sub">${fmtFull(x.created)}${x.author ? ' · ' + esc(x.author) : ''} · ${fmtSize(x.size)}</div></div><a class="btn-icon" href="api/versions/${x.id}/raw" title="Télécharger cette version">${SVG(P.dl, 18)}</a>${canEdit(it.perm) ? `<button class="btn-icon" data-vr="${x.id}" data-vn="${x.version}" title="Restaurer cette version">${SVG(P.restore, 18)}</button>` : ''}</li>`).join('')}</ul>
      ${v.versions.length ? '' : '<p class="sub">Aucune version précédente. Chaque enregistrement (OnlyOffice, éditeur de texte, restauration) conserve la version d\'avant.</p>'}`;
    $$('[data-vr]', box).forEach(b => b.onclick = () => confirmDlg('Restaurer cette version ?', `La version ${b.dataset.vn} deviendra la version actuelle. La version actuelle sera conservée dans l'historique.`, 'Restaurer', async () => {
      try { await api(`api/versions/${b.dataset.vr}/restore`, { body: {} }); toast('Version restaurée', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
    }, false));
  }
}
function toggleDetails() { S.details = !S.details; savePrefs(); render(); }

/* ============================== Administration ============================== */
function renderAdmin(c) {
  const a = S.admin; if (!a) { c.innerHTML = '<div class="loading"><span class="spin"></span></div>'; return; }
  const tab = S.adminTab || 'users';
  const totalUsed = a.users.reduce((s, u) => s + u.used, 0) + a.teams.reduce((s, t) => s + t.used, 0);
  let html = `<div class="stats">
    <div class="stat"><b>${a.users.length}</b><span>Utilisateurs</span></div>
    <div class="stat"><b>${a.teams.length}</b><span>Espaces d'équipe</span></div>
    <div class="stat"><b>${fmtSize(totalUsed)}</b><span>Espace utilisé</span></div>
    ${a.disk ? `<div class="stat"><b>${fmtSize(a.disk.free)}</b><span>Libres sur le disque (${fmtSize(a.disk.total)})</span></div>` : ''}
  </div>
  <div class="tabs" style="margin:0 0 16px;padding:0"><button data-at="users" class="${tab === 'users' ? 'on' : ''}">Comptes</button><button data-at="teams" class="${tab === 'teams' ? 'on' : ''}">Espaces d'équipe</button>${a.settings.configurable ? `<button data-at="settings" class="${tab === 'settings' ? 'on' : ''}">Paramètres</button>` : ''}</div>`;
  if (tab === 'users') {
    html += `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <label class="check" style="font-size:15px;flex:1"><input type="checkbox" id="adSignup" ${a.settings.allow_signup ? 'checked' : ''}> Autoriser les inscriptions libres</label>
      <button class="btn btn-primary" id="adNew">${SVG(P.user)}Créer un compte</button></div>
    <table class="list auto"><thead><tr><th>Nom</th><th class="hide-m">Adresse e-mail</th><th>Rôle</th><th class="hide-m">Stockage</th><th class="hide-m">Dernière connexion</th><th></th></tr></thead><tbody>
    ${a.users.map(u => `<tr class="row"><td class="n"><div><span class="av">${esc(initials(u.name))}</span><div style="min-width:0"><div class="name">${esc(u.name)}</div></div></div></td>
      <td class="hide-m sub">${esc(u.email)}</td>
      <td>${u.role === 'admin' ? '<span class="tag">Admin</span>' : '<span class="tag grey">Utilisateur</span>'}${u.totp ? ` <span class="tag green" title="Double authentification activée">${SVG(P.lock, 11)} 2FA</span>` : ''}${u.disabled ? ' <span class="tag red">Désactivé</span>' : ''}</td>
      <td class="hide-m"><div class="sub">${fmtSize(u.used)} / ${u.quota ? fmtSize(u.quota) : '∞'}</div>${u.quota ? `<div class="mini-bar"><i style="width:${Math.min(100, u.used / u.quota * 100)}%"></i></div>` : ''}</td>
      <td class="hide-m sub">${u.last_login ? fmtDate(u.last_login) : 'Jamais'}</td>
      <td><button class="btn btn-tertiary btn-sm" data-ue="${u.id}">Modifier</button></td></tr>`).join('')}
    </tbody></table>`;
  } else if (tab === 'settings') {
    const st = a.settings;
    html += `<form id="stf" style="max-width:720px" novalidate>
      <h3 style="font-size:18px;margin-bottom:12px">Général</h3>
      <div class="field"><label for="stName">Nom de l'application</label><input id="stName" value="${esc(st.app_name || '')}"></div>
      <div class="frow" style="flex-wrap:wrap"><div class="field"><label for="stQ">Quota par défaut</label><input id="stQ" value="${sizeToStr(st.default_quota)}"><div class="hint">Ex. 5G, 500M — 0 = illimité</div></div>
      <div class="field"><label for="stT">Corbeille (jours)</label><input id="stT" type="number" min="1" value="${st.trash_days}"></div>
      <div class="field"><label for="stV">Versions conservées</label><input id="stV" type="number" min="1" value="${st.max_versions}"></div></div>
      <h3 style="font-size:18px;margin:24px 0 12px">OnlyOffice Docs</h3>
      <div class="field"><label for="stOU">Adresse du serveur OnlyOffice</label><input id="stOU" placeholder="https://office.mondomaine.fr" value="${esc(st.oo_url || '')}"><div class="hint">Laisser vide pour désactiver l'édition des documents Office.</div></div>
      <div class="field"><label for="stOS">Secret JWT</label><input id="stOS" type="password" autocomplete="new-password" placeholder="${st.oo_secret_set ? '•••••••• (inchangé)' : 'Secret JWT du serveur OnlyOffice'}"></div>
      <div class="err" id="stE" style="color:var(--red);margin-bottom:12px"></div>
      <button class="btn btn-primary">Enregistrer</button></form>
      ${st.server ? `<h3 style="font-size:18px;margin:32px 0 12px">Serveur</h3><dl class="props">${Object.entries(st.server).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}`;
  } else {
    html += `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px"><p class="sub" style="flex:1;white-space:normal">Un espace d'équipe est un dossier commun qui n'appartient à personne : il a ses propres membres et son quota, et ne disparaît pas si un compte est supprimé.</p>
      <button class="btn btn-primary" id="adTeam">${SVG(P.team)}Créer un espace</button></div>
    ${a.teams.length ? `<table class="list auto"><thead><tr><th>Espace</th><th>Membres</th><th class="hide-m">Stockage</th><th class="hide-m">Fichiers</th><th></th></tr></thead><tbody>
    ${a.teams.map(t => `<tr class="row"><td class="n"><div>${SVG(P.team, 24)}<div class="name">${esc(t.name)}</div></div></td>
      <td class="sub">${t.members.length} membre${t.members.length > 1 ? 's' : ''}</td>
      <td class="hide-m"><div class="sub">${fmtSize(t.used)} / ${t.quota ? fmtSize(t.quota) : '∞'}</div>${t.quota ? `<div class="mini-bar"><i style="width:${Math.min(100, t.used / t.quota * 100)}%"></i></div>` : ''}</td>
      <td class="hide-m sub">${t.files}</td>
      <td style="white-space:nowrap"><button class="btn btn-tertiary btn-sm" data-to="${t.id}">Ouvrir</button> <button class="btn btn-tertiary btn-sm" data-te="${t.id}">Gérer</button></td></tr>`).join('')}
    </tbody></table>` : emptyBox(P.team, "Aucun espace d'équipe", "Créez un espace pour un service, une équipe pédagogique ou un projet.")}`;
  }
  c.innerHTML = html;
  $$('[data-at]', c).forEach(b => b.onclick = () => { S.adminTab = b.dataset.at; renderAdmin(c); });
  $('#adSignup') && ($('#adSignup').onchange = async e => { try { await api('api/admin/settings', { method: 'PUT', body: { allow_signup: e.target.checked } }); toast('Paramètre enregistré', 'ok'); } catch (err) { toast(err.message, 'err'); } });
  $('#adNew') && ($('#adNew').onclick = () => userDlg());
  $('#adTeam') && ($('#adTeam').onclick = () => inputDlg("Nouvel espace d'équipe", "Nom de l'espace", '', 'Créer', async v => {
    const r = await api('api/admin/teams', { body: { name: v, quota: '0' } }); toast('Espace créé — ajoutez-y des membres', 'ok'); await refreshMe(); await load(true); teamDlg(r.id, true);
  }, { hint: 'Ex. Service informatique, Direction, Équipe de maths…' }));
  $$('[data-ue]', c).forEach(b => b.onclick = () => userDlg(a.users.find(u => u.id === b.dataset.ue)));
  $('#stf') && ($('#stf').onsubmit = async e => {
    e.preventDefault();
    const body = { app_name: $('#stName').value, default_quota: $('#stQ').value || '0', trash_days: $('#stT').value, max_versions: $('#stV').value, oo_url: $('#stOU').value.trim() };
    if ($('#stOS').value) body.oo_secret = $('#stOS').value;
    try { await api('api/admin/settings', { method: 'PUT', body }); toast('Paramètres enregistrés', 'ok'); await refreshMe(); load(true); } catch (err) { $('#stE').textContent = err.message; }
  });
  $$('[data-te]', c).forEach(b => b.onclick = () => teamDlg(b.dataset.te, true));
  $$('[data-to]', c).forEach(b => b.onclick = () => go('t-' + b.dataset.to));
}
const sizeToStr = b => (!b ? '0' : b % 1024 ** 3 === 0 ? b / 1024 ** 3 + 'G' : b % 1024 ** 2 === 0 ? b / 1024 ** 2 + 'M' : String(b));
function userDlg(u) {
  const self = u && u.id === S.me.user.id;
  modal(`<form id="uf" novalidate><div class="modal-b"><h2>${u ? 'Modifier le compte' : 'Créer un compte'}</h2>
    <div class="field"><label for="ufN">Nom complet</label><input id="ufN" value="${esc(u?.name || '')}" required></div>
    <div class="field"><label for="ufE">Adresse e-mail</label><input id="ufE" type="email" value="${esc(u?.email || '')}" ${u ? 'readonly' : ''}></div>
    <div class="field"><label for="ufP">${u ? 'Nouveau mot de passe (laisser vide pour ne pas changer)' : 'Mot de passe'}</label><input id="ufP" type="text" autocomplete="new-password"><div class="hint">8 caractères minimum.</div></div>
    <div class="frow"><div class="field"><label for="ufQ">Quota</label><input id="ufQ" value="${u ? sizeToStr(u.quota) : sizeToStr(S.admin.settings.default_quota)}"><div class="hint">Ex. 5G, 500M — 0 = illimité</div></div>
    <div class="field"><label for="ufR">Rôle</label><select id="ufR" ${self ? 'disabled' : ''}><option value="user">Utilisateur</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Administrateur</option></select></div></div>
    ${u && !self ? `<label class="check"><input type="checkbox" id="ufD" ${u.disabled ? 'checked' : ''}> Compte désactivé (connexion impossible)</label>` : ''}
    ${u?.totp ? `<div class="alert" style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span style="flex:1">Double authentification activée.</span><button type="button" class="btn btn-secondary btn-sm" id="uf2fa">Réinitialiser la 2FA</button></div>` : ''}
    <div class="err" id="ufErr" style="color:var(--red);margin-top:12px"></div></div>
    <div class="modal-f">${u && !self ? '<button type="button" class="btn btn-tertiary" id="ufDel" style="margin-right:auto;color:var(--red)">Supprimer le compte</button>' : ''}<button type="button" class="btn btn-secondary" onclick="closeModal()">Annuler</button><button class="btn btn-primary">${u ? 'Enregistrer' : 'Créer'}</button></div></form>`);
  $('#uf').onsubmit = async e => {
    e.preventDefault();
    const body = { name: $('#ufN').value, quota: $('#ufQ').value || '0', role: $('#ufR').value };
    if ($('#ufP').value) body.password = $('#ufP').value;
    if ($('#ufD')) body.disabled = $('#ufD').checked;
    try {
      if (u) await api('api/admin/users/' + u.id, { method: 'PATCH', body });
      else await api('api/admin/users', { body: { ...body, email: $('#ufE').value } });
      closeModal(); toast(u ? 'Compte mis à jour' : 'Compte créé', 'ok'); load(true);
    } catch (err) { $('#ufErr').textContent = err.message; }
  };
  $('#uf2fa') && ($('#uf2fa').onclick = async () => { try { await api('api/admin/users/' + u.id, { method: 'PATCH', body: { reset2fa: true } }); toast('Double authentification réinitialisée', 'ok'); closeModal(); load(true); } catch (err) { toast(err.message, 'err'); } });
  $('#ufDel') && ($('#ufDel').onclick = () => confirmDlg('Supprimer ce compte ?', `Le compte de <b>${esc(u.name)}</b> et <b>tous ses fichiers</b> (${fmtSize(u.used)}) seront supprimés définitivement.`, 'Supprimer définitivement', async () => {
    try { await api('api/admin/users/' + u.id, { method: 'DELETE' }); toast('Compte supprimé'); load(true); } catch (err) { toast(err.message, 'err'); }
  }));
}

/* --- Espaces d'équipe : membres et réglages --- */
async function teamDlg(tid, adminMode) {
  let t;
  try { t = await api('api/teams/' + tid); } catch (e) { return toast(e.message, 'err'); }
  const myRole = t.members.find(m => m.user_id === S.me.user.id)?.role;
  const canManage = S.me.user.role === 'admin' || myRole === 'manager';
  const ROLES = [['manager', 'Responsable', 'Gère les membres, la corbeille et les partages'], ['member', 'Membre', 'Ajoute, modifie et supprime des fichiers'], ['reader', 'Lecteur', 'Consulte et télécharge uniquement']];
  const roleSel = (cur, attrs) => `<select class="sel" ${attrs} ${canManage ? '' : 'disabled'}>${ROLES.map(r => `<option value="${r[0]}" ${r[0] === cur ? 'selected' : ''}>${r[1]}</option>`).join('')}</select>`;
  modal(`<div class="modal-b"><h2>${SVG(P.team, 28)} ${esc(t.name)}</h2>
    ${adminMode && S.me.user.role === 'admin' ? `<form id="tf" class="frow" style="flex-wrap:wrap"><div class="field"><label for="tfN">Nom</label><input id="tfN" value="${esc(t.name)}"></div><div class="field" style="flex:0 0 140px"><label for="tfQ">Quota</label><input id="tfQ" value="${sizeToStr(t.quota)}"></div><div class="field" style="flex:0 0 auto"><button class="btn btn-secondary">Enregistrer</button></div></form>
    <p class="sub" style="margin:-6px 0 16px">${fmtSize(t.used)} utilisés · ${t.files} fichier(s) · quota 0 = illimité</p>` : ''}
    <h3 style="font-size:17px;margin-bottom:10px">Membres</h3>
    ${canManage ? `<form id="tmAdd" class="frow" style="flex-wrap:wrap"><div class="field" style="margin:0;flex:2;min-width:200px"><label for="tmE" class="sr">Adresse e-mail</label><input id="tmE" type="email" list="tmUsers" placeholder="Adresse e-mail d'un utilisateur" autocomplete="off"><datalist id="tmUsers"></datalist></div>
      <div class="field" style="margin:0;flex:0 0 auto">${roleSel('member', 'id="tmR"')}</div><button class="btn btn-primary" style="flex:0 0 auto">Ajouter</button></form>` : ''}
    <ul class="plist" style="margin-top:8px">${t.members.map(m => `<li><span class="av">${esc(initials(m.name))}</span><div><b>${esc(m.name)}</b>${m.user_id === S.me.user.id ? ' <span class="tag grey">vous</span>' : ''}<div class="sub">${esc(m.email)}</div></div>${roleSel(m.role, `data-mr="${esc(m.email)}"`)}${canManage || m.user_id === S.me.user.id ? `<button class="btn-icon" data-mdel="${m.user_id}" title="${m.user_id === S.me.user.id ? "Quitter l'espace" : 'Retirer'}">${SVG(P.close, 18)}</button>` : ''}</li>`).join('') || '<li class="sub">Aucun membre.</li>'}</ul>
    <details style="margin-top:14px"><summary class="sub" style="cursor:pointer">Rôles</summary><ul style="margin:8px 0 0 18px;font-size:14px">${ROLES.map(r => `<li><b>${r[1]}</b> : ${r[2]}</li>`).join('')}</ul></details>
  </div><div class="modal-f">${adminMode && S.me.user.role === 'admin' ? `<button class="btn btn-tertiary" id="tDel" style="margin-right:auto;color:var(--red)">Supprimer l'espace</button>` : ''}<button class="btn btn-primary" onclick="closeModal()">Terminé</button></div>`);
  modalOnClose = async () => { await refreshMe(); load(true); };
  const again = () => { modalOnClose = null; teamDlg(tid, adminMode); };
  $('#tf') && ($('#tf').onsubmit = async e => { e.preventDefault(); try { await api('api/admin/teams/' + tid, { method: 'PATCH', body: { name: $('#tfN').value, quota: $('#tfQ').value || '0' } }); toast('Espace mis à jour', 'ok'); again(); } catch (err) { toast(err.message, 'err'); } });
  const em = $('#tmE');
  if (em) em.oninput = async () => { const q = em.value.trim(); if (q.length < 2) return; const r = await api('api/users/lookup?q=' + encodeURIComponent(q)).catch(() => []); $('#tmUsers').innerHTML = r.map(u => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join(''); };
  $('#tmAdd') && ($('#tmAdd').onsubmit = async e => { e.preventDefault(); try { await api(`api/teams/${tid}/members`, { body: { email: em.value, role: $('#tmR').value } }); toast('Membre ajouté', 'ok'); again(); } catch (err) { toast(err.message, 'err'); } });
  $$('[data-mr]').forEach(s => s.onchange = async () => { try { await api(`api/teams/${tid}/members`, { body: { email: s.dataset.mr, role: s.value } }); toast('Rôle mis à jour', 'ok'); } catch (err) { toast(err.message, 'err'); } });
  $$('[data-mdel]').forEach(b => b.onclick = async () => { try { await api(`api/teams/${tid}/members/${b.dataset.mdel}`, { method: 'DELETE' }); if (b.dataset.mdel === S.me.user.id) { modalOnClose = null; closeModal(); await refreshMe(); return go(''); } again(); } catch (err) { toast(err.message, 'err'); } });
  $('#tDel') && ($('#tDel').onclick = () => confirmDlg("Supprimer l'espace ?", `L'espace <b>${esc(t.name)}</b> et <b>tous ses fichiers</b> (${fmtSize(t.used)}) seront supprimés définitivement.`, 'Supprimer définitivement', async () => {
    try { await api('api/admin/teams/' + tid, { method: 'DELETE' }); toast('Espace supprimé'); await refreshMe(); if (S.view === 'admin') load(true); else go(''); } catch (err) { toast(err.message, 'err'); }
  }));
}


/* ============================== Menus ============================== */
const mi = (k, label, a, opts = {}) => `<button role="menuitem" data-ma="${a}" class="${opts.danger ? 'danger' : ''}">${SVG(P[k])}${label}${opts.kb ? `<span class="kb">${opts.kb}</span>` : ''}</button>`;
function placeMenu(m, x, y) {
  m.classList.add('show');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  setTimeout(() => $('button', m)?.focus(), 10);
}
function hideMenus() { $$('.menu').forEach(m => m.classList.remove('show')); }
const isOO = it => S.me?.onlyoffice && it.type === 'file' && S.me.onlyoffice.view.includes(it.ext);
const ooEditable = it => S.me?.onlyoffice && S.me.onlyoffice.edit.includes(it.ext);
function showCtx(id, x, y) {
  const it = byId(id), m = $('#ctx'), multi = S.sel.size > 1 && S.sel.has(id);
  if (!it) return;
  const p = it.perm || (it.mine ? 'owner' : S.view === 'drive' ? S.perm : 'view');
  const ed = canEdit(p) || it.mine;
  let h = '';
  if (it.trashed_at) h = mi('restore', multi ? 'Restaurer la sélection' : 'Restaurer', 'restore') + (p === 'owner' ? '<hr>' + mi('trash', 'Supprimer définitivement', 'purge', { danger: true }) : '');
  else if (multi) h = mi('dl', 'Télécharger (zip)', 'download') + (ed ? mi('move', 'Déplacer…', 'move') : '') + mi('copy', 'Copier dans…', 'copyTo') + mi('star', 'Ajouter / retirer des favoris', 'star') + (ed ? mi('palette', 'Couleur…', 'color') : '') + (ed ? '<hr>' + mi('trash', 'Placer dans la corbeille', 'delete', { danger: true, kb: 'Suppr' }) : '');
  else {
    if (it.type === 'folder') h += mi('open', 'Ouvrir', 'open');
    else if (isOO(it)) {
      h += mi('edit', ooEditable(it) && ed ? 'Modifier dans OnlyOffice' : 'Ouvrir dans OnlyOffice', 'open');
      if (ooEditable(it) && ed) h += mi('eye', 'Ouvrir en lecture seule', 'openView');
      if (['image', 'video', 'audio', 'pdf', 'text'].includes(kind(it))) h += mi('eye', 'Aperçu rapide', 'preview');
    } else h += mi('eye', 'Aperçu', 'open');
    if (S.q || S.view !== 'drive') h += mi('folder', "Afficher l'emplacement", 'locate');
    h += '<hr>';
    if (p === 'owner') h += mi('share', 'Partager…', 'share');
    h += mi('dl', it.type === 'folder' ? 'Télécharger (zip)' : 'Télécharger', 'download');
    h += '<hr>';
    if (ed) h += mi('edit', 'Renommer', 'rename', { kb: 'F2' }) + mi('move', 'Déplacer…', 'move');
    h += mi('copy', ed ? 'Dupliquer' : 'Copier dans mon espace', 'copy') + (ed ? mi('copy', 'Copier dans…', 'copyTo') : '');
    if (ed && it.ext === 'zip') h += mi('unzip', 'Extraire ici', 'extract');
    h += mi(it.starred ? 'starO' : 'star', it.starred ? 'Retirer des favoris' : 'Ajouter aux favoris', 'star');
    if (ed) h += mi('palette', 'Couleur…', 'color');
    h += mi('comment', 'Commenter', 'comment');
    h += mi('info', 'Détails', 'info', { kb: 'I' });
    if (S.view === 'shared' && !it.mine) h += '<hr>' + mi('close', 'Retirer de mes partages', 'leave');
    if (ed) h += '<hr>' + mi('trash', 'Placer dans la corbeille', 'delete', { danger: true, kb: 'Suppr' });
  }
  m.innerHTML = h;
  $$('[data-ma]', m).forEach(b => b.onclick = () => { hideMenus(); multi ? bulk(b.dataset.ma) : act(b.dataset.ma, it); });
  placeMenu(m, x, y);
}
function showNewMenu(x, y) {
  const m = $('#newMenu');
  if (S.view === 'drive' && !S.q && !canEdit(S.perm)) { toast('Ce dossier est en lecture seule', 'err'); return; }
  const oo = !!S.me?.onlyoffice;
  const touch = matchMedia('(pointer:coarse)').matches;
  m.innerHTML = mi('newFolder', 'Nouveau dossier', 'folder') + '<hr>' + mi('upload', 'Envoyer des fichiers', 'files') + (touch ? mi('camera', 'Prendre une photo', 'cam') : mi('uploadDir', 'Envoyer un dossier', 'dir')) + '<hr>' +
    (oo ? `<button data-ma="docx">${icon({ type: 'file', name: 'a.docx' }, 20)}Document texte</button><button data-ma="xlsx">${icon({ type: 'file', name: 'a.xlsx' }, 20)}Classeur</button><button data-ma="pptx">${icon({ type: 'file', name: 'a.pptx' }, 20)}Présentation</button>` : '') +
    `<button data-ma="txt">${icon({ type: 'file', name: 'a.txt' }, 20)}Fichier texte brut</button>` +
    (S.view !== 'drive' || S.q ? '<hr><div class="mh" style="border:none;margin:0;padding-top:4px"><small>Sera créé dans « Mon espace »</small></div>' : '');
  $$('[data-ma]', m).forEach(b => b.onclick = () => {
    hideMenus();
    const a = b.dataset.ma;
    if (a === 'folder') newFolder();
    else if (a === 'files') $('#fileIn').click();
    else if (a === 'dir') $('#folderIn').click();
    else if (a === 'cam') $('#camIn').click();
    else newDoc(a);
  });
  placeMenu(m, x, y);
}
function showUserMenu() {
  const m = $('#userMenu'), u = S.me.user, th = Theme.get();
  m.innerHTML = `<div class="mh"><b>${esc(u.name)}</b><small>${esc(u.email)}</small></div>` + mi('user', 'Mon profil', 'profile') +
    `<button data-ma="theme">${SVG(P.moon)}Thème : ${{ auto: 'automatique', light: 'clair', dark: 'sombre' }[th]}</button>` +
    (u.role === 'admin' ? mi('admin', 'Administration', 'admin') : '') + '<hr>' + mi('logout', 'Se déconnecter', 'logout');
  $$('[data-ma]', m).forEach(b => b.onclick = async () => {
    hideMenus();
    const a = b.dataset.ma;
    if (a === 'profile') profileDlg();
    else if (a === 'theme') { Theme.set({ auto: 'light', light: 'dark', dark: 'auto' }[th]); showUserMenu(); }
    else if (a === 'admin') go('admin');
    else if (a === 'logout') { await api('api/logout', { body: {} }); location.href = 'login'; }
  });
  const r = $('#userBtn').getBoundingClientRect();
  placeMenu(m, r.right - 260, r.bottom + 6);
}
document.addEventListener('mousedown', e => { if (!e.target.closest('.menu') && !e.target.closest('#newBtn,#userBtn,#fab,[data-more]')) hideMenus(); });

/* ============================== Actions ============================== */
function openItem(it) {
  if (!it) return;
  if (it.trashed_at) { toast("Restaurez l'élément pour l'ouvrir"); return; }
  if (it.type === 'folder') return openFolder(it.id);
  const k = kind(it);
  if (['image', 'video', 'audio', 'pdf', 'text'].includes(k) && !(k === 'text' && it.ext === 'csv' && isOO(it))) return preview(it);
  if (isOO(it)) return openEditor(it);
  preview(it);
}
function openEditor(it, view) {
  const w = window.open(`edit/${it.id}${view ? '?mode=view' : ''}`, '_blank');
  if (!w) location.href = `edit/${it.id}${view ? '?mode=view' : ''}`;
}
function download(ids) {
  ids = [].concat(ids);
  if (ids.length === 1 && byId(ids[0])?.type === 'file') location.href = `api/items/${ids[0]}/raw?dl=1`;
  else location.href = `api/zip?ids=${ids.join(',')}`;
}
async function act(a, it) {
  const id = it.id;
  try {
    switch (a) {
      case 'open': return openItem(it);
      case 'openView': return openEditor(it, true);
      case 'preview': return preview(it);
      case 'locate': return it.parent_id ? openFolder(it.parent_id) : it.team ? go('t-' + it.owner_id) : openFolder('root');
      case 'color': return colorDlg([id]);
      case 'comment': S.sel = new Set([id]); S.details = true; S.detailTab = 'comments'; savePrefs(); render(); return setTimeout(() => $('#ctext')?.focus(), 400);
      case 'extract': {
        toast('Extraction en cours…');
        const r = await api(`api/items/${id}/extract`, { body: {} });
        toast(`${r.count} fichier${r.count > 1 ? 's' : ''} extrait${r.count > 1 ? 's' : ''} dans « ${r.folder.name} »`, 'ok', 'Ouvrir', () => openFolder(r.folder.id));
        return reload();
      }
      case 'rename': return renameDlg(it);
      case 'move': return moveDlg([id], 'move');
      case 'copyTo': return moveDlg([id], 'copy');
      case 'copy': await api('api/copy', { body: { ids: [id] } }); toast(it.mine || canEdit(it.perm) ? 'Copie créée' : 'Copié dans Mon espace', 'ok'); return reload();
      case 'star': await api('api/items/' + id, { method: 'PATCH', body: { starred: !it.starred } }); toast(it.starred ? 'Retiré des favoris' : 'Ajouté aux favoris'); return load(true);
      case 'info': S.sel = new Set([id]); S.details = true; savePrefs(); return render();
      case 'share': return shareDlg(it);
      case 'download': return download(id);
      case 'leave': await api(`api/items/${id}/access/${S.me.user.id}`, { method: 'DELETE' }); toast('Partage retiré'); return reload();
      case 'delete':
        await api('api/trash', { body: { ids: [id] } }); S.sel.delete(id);
        toast(`« ${it.name} » placé dans la corbeille`, '', 'Annuler', async () => { await api('api/restore', { body: { ids: [id] } }).catch(e => toast(e.message, 'err')); reload(); });
        return reload();
      case 'restore': await api('api/restore', { body: { ids: [id] } }); toast('Élément restauré', 'ok'); return reload();
      case 'purge': return confirmDlg('Supprimer définitivement ?', `« ${esc(it.name)} » sera supprimé définitivement, ainsi que ses versions. Cette action est irréversible.`, 'Supprimer définitivement', async () => { await api('api/purge', { body: { ids: [id] } }); toast('Élément supprimé'); reload(); });
    }
  } catch (e) { toast(e.message, 'err'); }
}
async function bulk(a) {
  const ids = [...S.sel]; if (!ids.length) return;
  const n = ids.length, s = n > 1 ? 's' : '';
  try {
    switch (a) {
      case 'download': return download(ids);
      case 'move': return moveDlg(ids, 'move');
      case 'copy': case 'copyTo': return moveDlg(ids, 'copy');
      case 'color': return colorDlg(ids);
      case 'star': { const all = ids.every(id => byId(id)?.starred); for (const id of ids) await api('api/items/' + id, { method: 'PATCH', body: { starred: !all } }); toast(all ? 'Retirés des favoris' : 'Ajoutés aux favoris'); return load(true); }
      case 'delete':
        if (S.view === 'trash') return bulk('purge');
        await api('api/trash', { body: { ids } }); S.sel.clear();
        toast(`${n} élément${s} placé${s} dans la corbeille`, '', 'Annuler', async () => { await api('api/restore', { body: { ids } }).catch(e => toast(e.message, 'err')); reload(); });
        return reload();
      case 'restore': await api('api/restore', { body: { ids } }); S.sel.clear(); toast(`${n} élément${s} restauré${s}`, 'ok'); return reload();
      case 'purge': return confirmDlg('Supprimer définitivement ?', `${n} élément${s} ${n > 1 ? 'seront supprimés' : 'sera supprimé'} définitivement. Cette action est irréversible.`, 'Supprimer définitivement', async () => { await api('api/purge', { body: { ids } }); S.sel.clear(); toast('Suppression effectuée'); reload(); });
    }
  } catch (e) { toast(e.message, 'err'); reload(); }
}
function emptyTrash() {
  confirmDlg('Vider la corbeille ?', `Les ${S.items.length} élément(s) de la corbeille seront supprimés définitivement. Cette action est irréversible.`, 'Vider la corbeille', async () => {
    try { await api('api/trash/empty', { body: {} }); toast('Corbeille vidée'); reload(); } catch (e) { toast(e.message, 'err'); }
  });
}

/* ============================== Dialogues ============================== */
function newFolder() {
  inputDlg('Nouveau dossier', 'Nom du dossier', 'Nouveau dossier', 'Créer', async v => {
    await api('api/folders', { body: { parent: targetFolder(), name: v } }); toast('Dossier créé', 'ok'); reload();
  }, { name: true });
}
function newDoc(kindName) {
  const L = { docx: ['Nouveau document', 'Document sans titre'], xlsx: ['Nouveau classeur', 'Classeur sans titre'], pptx: ['Nouvelle présentation', 'Présentation sans titre'], txt: ['Nouveau fichier texte', 'Sans titre.txt'] }[kindName];
  inputDlg(L[0], 'Nom', L[1], 'Créer', async v => {
    const it = await api('api/new', { body: { parent: targetFolder(), kind: kindName, name: v } });
    reload();
    if (kindName === 'txt') setTimeout(() => preview(it, true), 300);
    else openEditor(it);
  }, { name: true, keepExt: kindName === 'txt' });
}
function renameDlg(it) {
  inputDlg('Renommer', 'Nouveau nom', it.name, 'Renommer', async v => {
    if (v === it.name) return;
    await api('api/items/' + it.id, { method: 'PATCH', body: { name: v } }); toast('Élément renommé', 'ok'); reload();
  }, { name: true, keepExt: it.type === 'file' });
}
function descDlg(it) {
  modal(`<form id="df"><div class="modal-b"><h2>Description</h2><div class="field"><label for="dfT">Description de « ${esc(it.name)} »</label><textarea id="dfT" rows="5" maxlength="2000">${esc(it.description || '')}</textarea><div class="hint">La description est prise en compte par la recherche.</div></div></div><div class="modal-f"><button type="button" class="btn btn-secondary" onclick="closeModal()">Annuler</button><button class="btn btn-primary">Enregistrer</button></div></form>`);
  $('#df').onsubmit = async e => { e.preventDefault(); try { await api('api/items/' + it.id, { method: 'PATCH', body: { description: $('#dfT').value } }); closeModal(); renderDetails(); } catch (err) { toast(err.message, 'err'); } };
}
/* --- Couleurs --- */
function colorDlg(ids) {
  const items = ids.map(byId).filter(Boolean);
  const cur = items.length === 1 ? items[0].color : null;
  modal(`<div class="modal-b"><h2>Couleur</h2><p class="sub" style="margin-bottom:16px;white-space:normal">Pour repérer ${items.length > 1 ? 'ces ' + items.length + ' éléments' : '« ' + esc(items[0]?.name) + ' »'} d'un coup d'œil.</p>
    <div class="swatches">${Object.keys(COLOR_HEX).map(c => `<button data-c="${c}" class="${cur === c ? 'on' : ''}" title="${COLOR_L[c]}"><i style="background:${COLOR_HEX[c]}"></i>${COLOR_L[c]}</button>`).join('')}<button data-c="" class="${!cur ? 'on' : ''}"><i class="none"></i>Aucune</button></div></div>`);
  $$('[data-c]').forEach(b => b.onclick = async () => {
    try { for (const id of ids) await api('api/items/' + id, { method: 'PATCH', body: { color: b.dataset.c || null } }); closeModal(); load(true); }
    catch (e) { toast(e.message, 'err'); }
  });
}

/* --- Profil, sécurité, WebDAV --- */
async function profileDlg(tab = 'profile') {
  const u = S.me.user;
  const tabs = `<div class="tabs" style="margin:0 0 20px;padding:0">${[['profile', 'Profil'], ['security', 'Sécurité'], ['webdav', 'Accès WebDAV']].map(t => `<button data-pt="${t[0]}" class="${t[0] === tab ? 'on' : ''}">${t[1]}</button>`).join('')}</div>`;
  let body = '';
  if (tab === 'profile') body = `<form id="pf" novalidate>
    <div class="field"><label for="pfN">Nom affiché</label><input id="pfN" value="${esc(u.name)}"><div class="hint">Visible dans l'historique, les commentaires et OnlyOffice.</div></div>
    <div class="field"><label>Adresse e-mail</label><input value="${esc(u.email)}" readonly></div>
    <h3 style="font-size:17px;margin:24px 0 12px">Changer de mot de passe</h3>
    <div class="field"><label for="pfC">Mot de passe actuel</label><input id="pfC" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="pfP">Nouveau mot de passe</label><input id="pfP" type="password" autocomplete="new-password"><div class="hint">8 caractères minimum.</div></div>
    <div class="err" id="pfE" style="color:var(--red)"></div><button class="btn btn-primary">Enregistrer</button></form>`;
  else if (tab === 'security') body = u.totp
    ? `<div class="alert ok" style="margin-bottom:20px">La double authentification est <b>activée</b>. Un code de votre application vous est demandé à chaque connexion.</div>
       <form id="d2f"><p style="margin-bottom:12px">Pour la désactiver, saisissez votre mot de passe :</p><div class="field"><label for="d2p">Mot de passe</label><input id="d2p" type="password" autocomplete="current-password"></div><div class="err" id="d2e"></div><button class="btn btn-secondary" style="color:var(--red);box-shadow:inset 0 0 0 1px var(--red)">Désactiver la double authentification</button></form>`
    : `<p style="margin-bottom:16px">La double authentification protège votre compte même si votre mot de passe est découvert : en plus du mot de passe, un code à 6 chiffres généré par une application (Google Authenticator, Microsoft Authenticator, FreeOTP, Aegis…) est demandé.</p>
       <div id="s2"><button class="btn btn-primary" id="s2go">${SVG(P.lock, 18)}Activer la double authentification</button></div>`;
  else body = `<p style="margin-bottom:12px;white-space:normal">Montez votre espace comme un lecteur réseau. Utilisez votre adresse e-mail et un <b>mot de passe d'application</b> (obligatoire si la double authentification est activée).</p>
    <div class="field"><label>Adresse WebDAV</label><div class="frow"><input id="davUrl" value="${esc(S.me.appUrl)}/dav/" readonly><button type="button" class="btn btn-secondary" style="flex:0 0 auto" id="davCp">Copier</button></div></div>
    <details style="margin-bottom:18px"><summary style="cursor:pointer;color:var(--blue);font-weight:600">Comment connecter…</summary><div class="howto">
      <p><b>Windows</b> : Explorateur de fichiers → clic droit sur « Ce PC » → <i>Connecter un lecteur réseau</i> → coller l'adresse → cocher <i>Se connecter à l'aide d'informations d'identification différentes</i>.</p>
      <p><b>macOS</b> : Finder → <i>Aller</i> → <i>Se connecter au serveur</i> (⌘K) → coller l'adresse.</p>
      <p><b>Linux</b> : gestionnaire de fichiers → <i>Autres emplacements</i> → <code>davs://${esc(S.me.appUrl.replace(/^https?:\/\//, ''))}/dav/</code></p>
      <p><b>Android / iOS</b> : OnlyOffice Documents → <i>Stockages</i> → <i>WebDAV</i>, ou toute appli de fichiers compatible WebDAV.</p></div></details>
    <h3 style="font-size:17px;margin-bottom:10px">Mots de passe d'application</h3>
    <form id="apf" class="frow" style="margin-bottom:12px"><div class="field" style="margin:0"><label for="apN" class="sr">Nom de l'appareil</label><input id="apN" placeholder="Ex. PC du bureau, téléphone…"></div><button class="btn btn-primary" style="flex:0 0 auto">Créer</button></form>
    <div id="apNew"></div><ul class="plist" id="apList"><li class="loading"><span class="spin"></span></li></ul>`;
  modal(`<div class="modal-b"><h2>${SVG(P.user, 26)} Mon compte</h2>${tabs}${body}</div>`, 'lg');
  $$('[data-pt]').forEach(b => b.onclick = () => profileDlg(b.dataset.pt));
  if (tab === 'profile') $('#pf').onsubmit = async e => {
    e.preventDefault();
    const b = { name: $('#pfN').value };
    if ($('#pfP').value) Object.assign(b, { password: $('#pfP').value, current: $('#pfC').value });
    try { await api('api/me', { method: 'PATCH', body: b }); closeModal(); toast('Profil mis à jour', 'ok'); refreshMe(); } catch (err) { $('#pfE').textContent = err.message; }
  };
  if (tab === 'security' && u.totp) $('#d2f').onsubmit = async e => {
    e.preventDefault();
    try { await api('api/me/2fa/disable', { body: { password: $('#d2p').value } }); await refreshMe(); toast('Double authentification désactivée'); profileDlg('security'); } catch (err) { $('#d2e').textContent = err.message; }
  };
  if (tab === 'security' && !u.totp) $('#s2go').onclick = async () => {
    const r = await api('api/me/2fa/setup', { body: {} }).catch(e => toast(e.message, 'err'));
    if (!r) return;
    $('#s2').innerHTML = `<ol class="steps"><li>Scannez ce QR code avec votre application d'authentification :<div class="qr">${r.qr || qrSvg(r.uri)}</div><div class="sub" style="white-space:normal">Ou saisissez la clé manuellement : <code style="user-select:all">${r.secret.match(/.{1,4}/g).join(' ')}</code></div></li>
      <li>Saisissez le code à 6 chiffres affiché par l'application :<form id="s2f" class="frow" style="max-width:320px;margin-top:8px"><div class="field" style="margin:0"><input id="s2c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="font-size:20px;letter-spacing:.2em;text-align:center"></div><button class="btn btn-primary" style="flex:0 0 auto">Vérifier</button></form><div class="err" id="s2e" style="color:var(--red);margin-top:6px"></div></li></ol>`;
    $('#s2c').focus();
    $('#s2f').onsubmit = async e => {
      e.preventDefault();
      try {
        const x = await api('api/me/2fa/enable', { body: { code: $('#s2c').value } });
        await refreshMe();
        $('#s2').innerHTML = `<div class="alert ok" style="margin-bottom:16px">Double authentification activée.</div><p style="margin-bottom:8px"><b>Codes de secours</b> — notez-les et gardez-les en lieu sûr. Chacun permet de se connecter une seule fois si vous perdez votre téléphone :</p><div class="codes">${x.codes.map(c => `<code>${c}</code>`).join('')}</div><button class="btn btn-secondary btn-sm" id="cpCodes" style="margin-top:12px">Copier les codes</button>`;
        $('#cpCodes').onclick = () => navigator.clipboard.writeText(x.codes.join('\n')).then(() => toast('Codes copiés', 'ok')).catch(() => { });
      } catch (err) { $('#s2e').textContent = err.message; }
    };
  };
  if (tab === 'webdav') {
    $('#davCp').onclick = () => navigator.clipboard.writeText($('#davUrl').value).then(() => toast('Adresse copiée', 'ok')).catch(() => $('#davUrl').select());
    const draw = async () => {
      const r = await api('api/me/app-passwords').catch(() => ({ items: [] }));
      $('#apList').innerHTML = r.items.map(a => `<li>${SVG(P.lock, 20)}<div><b>${esc(a.name)}</b><div class="sub">Créé ${fmtDate(a.created).toLowerCase()} · ${a.last_used ? 'utilisé ' + fmtDate(a.last_used).toLowerCase() : 'jamais utilisé'}</div></div><button class="btn btn-tertiary btn-sm" data-apd="${a.id}" style="color:var(--red)">Révoquer</button></li>`).join('') || '<li class="sub" style="border:none">Aucun mot de passe d\'application.</li>';
      $$('[data-apd]').forEach(b => b.onclick = async () => { await api('api/me/app-passwords/' + b.dataset.apd, { method: 'DELETE' }); toast('Mot de passe révoqué'); draw(); });
    };
    draw();
    $('#apf').onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await api('api/me/app-passwords', { body: { name: $('#apN').value } });
        $('#apN').value = '';
        $('#apNew').innerHTML = `<div class="alert ok" style="margin-bottom:12px">Copiez ce mot de passe maintenant, il ne sera plus affiché :<div class="frow" style="margin-top:8px"><input class="input" value="${r.password}" readonly style="font:600 18px ui-monospace,monospace;letter-spacing:.05em"><button type="button" class="btn btn-primary" style="flex:0 0 auto" id="apCp">Copier</button></div><div class="sub" style="margin-top:6px;white-space:normal">Identifiant : ${esc(r.login)}</div></div>`;
        $('#apCp').onclick = () => navigator.clipboard.writeText(r.password).then(() => toast('Mot de passe copié', 'ok')).catch(() => { });
        draw();
      } catch (err) { toast(err.message, 'err'); }
    };
  }
}

async function moveDlg(ids, mode) {
  const items = ids.map(byId).filter(Boolean);
  const roots = [{ id: 'root', name: 'Mon espace', ic: P.home }].concat((S.me.teams || []).filter(t => t.role !== 'reader').map(t => ({ id: 'team:' + t.id, name: t.name, ic: P.team })));
  let target = S.view === 'drive' && writable() ? S.folder : 'root';
  const tree = {};
  const loadDir = async pid => (tree[pid] ||= (await api('api/folder/' + pid)).items.filter(i => i.type === 'folder'));
  const open = new Set(['root', target]);
  if (S.view === 'drive') { S.path.forEach(p => open.add(p.id)); if (S.root === 'team' && S.team) open.add('team:' + S.team.id); }
  const blocked = id => mode === 'move' && ids.includes(id);
  const arrow = (id, has) => `<span data-tg="${id}" class="tg">${has ? (open.has(id) ? '▾' : '▸') : ''}</span>`;
  async function draw() {
    const rows = [];
    const walk = async (pid, depth) => {
      for (const f of (await loadDir(pid)).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }))) {
        rows.push(`<li><button type="button" data-t="${f.id}" style="padding-left:${12 + depth * 22}px" ${blocked(f.id) ? 'disabled' : ''}>${arrow(f.id, f.children)}${icon(f, 20)} ${esc(f.name)}</button></li>`);
        if (open.has(f.id) && !blocked(f.id)) await walk(f.id, depth + 1);
      }
    };
    for (const r of roots) {
      rows.push(`<li><button type="button" data-t="${r.id}">${arrow(r.id, true)}${SVG(r.ic, 20)} <b>${esc(r.name)}</b></button></li>`);
      if (open.has(r.id)) await walk(r.id, 1);
    }
    $('#mvTree').innerHTML = rows.join('');
    $$('#mvTree [data-t]').forEach(b => {
      b.classList.toggle('on', b.dataset.t === target);
      b.onclick = e => {
        const id = b.dataset.t;
        if (e.target.dataset.tg) { open.has(id) ? open.delete(id) : open.add(id); return draw(); }
        target = id; open.add(id); draw();
      };
    });
  }
  modal(`<div class="modal-b"><h2>${mode === 'move' ? 'Déplacer' : 'Copier'} ${items.length > 1 ? items.length + ' éléments' : '« ' + esc(items[0]?.name) + ' »'}</h2><p class="sub" style="margin-bottom:12px;white-space:normal">Choisissez le dossier de destination.</p><ul class="tree" id="mvTree"><li class="loading"><span class="spin"></span></li></ul></div>
    <div class="modal-f"><button class="btn btn-tertiary" style="margin-right:auto" id="mvNew">${SVG(P.newFolder, 18)}Nouveau dossier</button><button class="btn btn-secondary" onclick="closeModal()">Annuler</button><button class="btn btn-primary" id="mvOk">${mode === 'move' ? 'Déplacer ici' : 'Copier ici'}</button></div>`);
  await draw();
  $('#mvOk').onclick = async () => {
    try {
      if (mode === 'move') { const r = await api('api/move', { body: { ids, target } }); toast(r.moved ? `${r.moved} élément${r.moved > 1 ? 's' : ''} déplacé${r.moved > 1 ? 's' : ''}` : 'Aucun déplacement nécessaire', r.moved ? 'ok' : ''); }
      else { await api('api/copy', { body: { ids, target } }); toast('Copie effectuée', 'ok'); }
      closeModal(); S.sel.clear(); reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#mvNew').onclick = () => {
    const back = { ids, mode };
    inputDlg('Nouveau dossier', 'Nom du dossier', 'Nouveau dossier', 'Créer', async v => {
      const f = await api('api/folders', { body: { parent: target, name: v } });
      setTimeout(() => moveDlg(back.ids, back.mode).then(() => { }), 0);
      toast(`Dossier « ${f.name} » créé`, 'ok');
    }, { name: true });
  };
}

/* --- Partage --- */
async function shareDlg(it) {
  let data;
  try { data = await api(`api/items/${it.id}/shares`); } catch (e) { return toast(e.message, 'err'); }
  const MODES = [['view', 'Lecture', 'Consulter et télécharger'], ['edit', 'Modification', it.type === 'folder' ? 'Consulter, envoyer, modifier' : 'Modifier dans OnlyOffice'], ['upload', 'Dépôt seul', 'Déposer des fichiers sans voir le contenu']];
  const draw = () => {
    modal(`<div class="modal-b"><h2>${icon(it, 30)} <span style="min-width:0;overflow:hidden;text-overflow:ellipsis">Partager « ${esc(it.name)} »</span></h2>
      <section><h3 style="font-size:17px;margin-bottom:10px">${SVG(P.people, 18)} Avec des personnes</h3>
        <form id="shAdd" class="frow" style="flex-wrap:wrap"><div class="field" style="margin:0;flex:2;min-width:200px"><label for="shEmail" class="sr">Adresse e-mail</label><input id="shEmail" type="email" list="shUsers" placeholder="Adresse e-mail d'un utilisateur" autocomplete="off"><datalist id="shUsers"></datalist></div>
        <div class="field" style="margin:0;flex:0 0 auto"><label for="shPerm" class="sr">Droits</label><select id="shPerm"><option value="view">Lecture</option><option value="edit">Modification</option></select></div>
        <button class="btn btn-primary" style="flex:0 0 auto">Ajouter</button></form>
        <ul class="plist" style="margin-top:8px"><li><span class="av">${esc(initials(data.owner))}</span><div><b>${esc(data.owner)}</b><div class="sub">Propriétaire</div></div></li>
        ${data.access.map(a => `<li><span class="av">${esc(initials(a.name))}</span><div><b>${esc(a.name)}</b><div class="sub">${esc(a.email)}</div></div><select class="sel" data-ap="${a.user_id}" data-em="${esc(a.email)}"><option value="view">Lecture</option><option value="edit" ${a.perm === 'edit' ? 'selected' : ''}>Modification</option></select><button class="btn-icon" data-arm="${a.user_id}" title="Retirer l'accès">${SVG(P.close, 18)}</button></li>`).join('')}</ul>
      </section>
      <section class="share-sec"><h3>${SVG(P.link, 18)} Liens de partage</h3>
        ${data.links.map(l => `<div class="link-card"><div class="lc-top"><span class="tag ${l.mode === 'view' ? 'grey' : l.mode === 'upload' ? 'green' : ''}">${MODES.find(m => m[0] === l.mode)[1]}</span>${l.protected ? `<span class="tag grey">${SVG(P.lock, 12)} Mot de passe</span>` : ''}${l.expires ? `<span class="tag ${l.expires < Date.now() ? 'red' : 'grey'}">${l.expires < Date.now() ? 'Expiré' : "Jusqu'au " + new Date(l.expires).toLocaleDateString('fr-FR')}</span>` : ''}<span class="sub" style="margin-left:auto">${l.views} ouverture${l.views > 1 ? 's' : ''}</span></div>
          <div class="lc-top" style="margin-top:8px"><input class="url" value="${esc(l.url)}" readonly aria-label="Lien"><button class="btn btn-secondary btn-sm" data-cp="${esc(l.url)}">Copier</button><button class="btn-icon" data-lrm="${l.token}" title="Supprimer le lien" style="color:var(--red)">${SVG(P.trash, 18)}</button></div></div>`).join('') || '<p class="sub" style="margin-bottom:12px">Aucun lien actif.</p>'}
        <details ${data.links.length ? '' : 'open'} style="margin-top:6px"><summary style="cursor:pointer;color:var(--blue);font-weight:600;margin-bottom:12px">Créer un lien</summary>
          <form id="shLink"><div class="modes">${MODES.map((m, i) => `<label><input type="radio" name="lm" value="${m[0]}" ${i === 0 ? 'checked' : ''} ${m[0] === 'upload' && it.type !== 'folder' ? 'disabled' : ''}><b>${m[1]}</b><small>${m[2]}</small></label>`).join('')}</div>
          <div class="frow" style="flex-wrap:wrap"><div class="field"><label for="shPw">Mot de passe (facultatif)</label><input id="shPw" type="text" autocomplete="off"></div><div class="field"><label for="shExp">Expire le (facultatif)</label><input id="shExp" type="date" min="${new Date().toISOString().slice(0, 10)}"></div></div>
          <button class="btn btn-primary">${SVG(P.link, 18)}Créer le lien</button></form></details>
      </section></div>
      <div class="modal-f"><button class="btn btn-primary" onclick="closeModal()">Terminé</button></div>`);
    modalOnClose = () => reload();
    const email = $('#shEmail');
    email.oninput = async () => { const q = email.value.trim(); if (q.length < 2) return; const r = await api('api/users/lookup?q=' + encodeURIComponent(q)).catch(() => []); $('#shUsers').innerHTML = r.map(u => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join(''); };
    $('#shAdd').onsubmit = async e => { e.preventDefault(); try { await api(`api/items/${it.id}/access`, { body: { email: email.value, perm: $('#shPerm').value } }); toast('Accès ajouté', 'ok'); refresh(); } catch (err) { toast(err.message, 'err'); } };
    $$('[data-ap]').forEach(s => s.onchange = async () => { try { await api(`api/items/${it.id}/access`, { body: { email: s.dataset.em, perm: s.value } }); toast('Droits mis à jour', 'ok'); } catch (err) { toast(err.message, 'err'); } });
    $$('[data-arm]').forEach(b => b.onclick = async () => { await api(`api/items/${it.id}/access/${b.dataset.arm}`, { method: 'DELETE' }).catch(e => toast(e.message, 'err')); refresh(); });
    $$('[data-cp]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.cp); toast('Lien copié', 'ok'); } catch (e) { b.previousElementSibling.select(); toast('Faites Ctrl+C pour copier'); } });
    $$('[data-lrm]').forEach(b => b.onclick = async () => { await api('api/links/' + b.dataset.lrm, { method: 'DELETE' }).catch(e => toast(e.message, 'err')); toast('Lien supprimé'); refresh(); });
    $('#shLink').onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await api(`api/items/${it.id}/links`, { body: { mode: $('input[name=lm]:checked').value, password: $('#shPw').value || null, expires: $('#shExp').value || null } });
        try { await navigator.clipboard.writeText(r.url); toast('Lien créé et copié', 'ok'); } catch (_) { toast('Lien créé', 'ok'); }
        refresh();
      } catch (err) { toast(err.message, 'err'); }
    };
  };
  const refresh = async () => { data = await api(`api/items/${it.id}/shares`); modalOnClose = null; draw(); };
  draw();
}

/* --- Aperçu --- */
async function preview(it, startEdit) {
  const files = visible().filter(i => i.type === 'file' && !i.trashed_at);
  const idx = files.findIndex(f => f.id === it.id), k = kind(it), u = `api/items/${it.id}/raw?v=${it.version}`;
  const ed = canEdit(it.perm) || (S.view === 'drive' && canEdit(S.perm));
  let body;
  if (k === 'image') body = `<img src="${u}" alt="${esc(it.name)}">`;
  else if (k === 'video') body = `<video src="${u}" controls autoplay></video>`;
  else if (k === 'audio') body = `<div style="padding:48px;text-align:center">${icon(it, 96)}<br><br><audio src="${u}" controls autoplay></audio></div>`;
  else if (k === 'pdf') body = `<iframe src="${u}" title="${esc(it.name)}"></iframe>`;
  else if (k === 'text') body = '<div class="loading"><span class="spin"></span></div>';
  else body = `<div class="empty">${icon(it, 96)}<h2>Aperçu non disponible</h2><p>Ce type de fichier (${KIND[k].l}${it.ext ? ', .' + esc(it.ext) : ''}) ne peut pas être affiché dans le navigateur.</p><p style="margin-top:16px"><button class="btn btn-primary" id="pvDl2">${SVG(P.dl)}Télécharger</button></p></div>`;
  const m = modal(`<div class="modal-b"><h2>${icon(it, 26)} <span class="name" style="font-size:19px">${esc(it.name)}</span></h2><div class="stage" id="stage">${body}</div>
    <div class="viewer-nav"><button class="btn btn-tertiary btn-sm" id="pvPrev" ${idx <= 0 ? 'disabled' : ''}>‹ Précédent</button>
    <span class="sub">${fmtSize(it.size)}${files.length > 1 && idx >= 0 ? ` · ${idx + 1} / ${files.length}` : ''}</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${k === 'text' && ed ? `<button class="btn btn-secondary btn-sm" id="pvEdit">${SVG(P.edit, 16)}Modifier</button>` : ''}${isOO(it) ? `<button class="btn btn-secondary btn-sm" id="pvOO">${SVG(P.open, 16)}OnlyOffice</button>` : ''}${it.perm === 'owner' ? `<button class="btn btn-secondary btn-sm" id="pvShare">${SVG(P.share, 16)}Partager</button>` : ''}<button class="btn btn-primary btn-sm" id="pvDl">${SVG(P.dl, 16)}Télécharger</button>
    <button class="btn btn-tertiary btn-sm" id="pvNext" ${idx < 0 || idx >= files.length - 1 ? 'disabled' : ''}>Suivant ›</button></div></div></div>`, 'viewer');
  $('#pvPrev').onclick = () => idx > 0 && preview(files[idx - 1]);
  $('#pvNext').onclick = () => idx < files.length - 1 && preview(files[idx + 1]);
  $('#pvDl').onclick = () => download(it.id);
  $('#pvDl2') && ($('#pvDl2').onclick = () => download(it.id));
  $('#pvShare') && ($('#pvShare').onclick = () => shareDlg(it));
  $('#pvOO') && ($('#pvOO').onclick = () => { closeModal(); openEditor(it); });
  m.onkeydown = e => { if (e.target.matches('textarea')) return; if (e.key === 'ArrowLeft') $('#pvPrev').click(); if (e.key === 'ArrowRight') $('#pvNext').click(); };
  if (k === 'text') {
    let txt = '';
    try { const r = await fetch(u); txt = await r.text(); } catch (e) { txt = 'Impossible de charger le fichier.'; }
    if (!$('#stage')) return;
    const big = txt.length > 400000;
    $('#stage').innerHTML = `<pre>${esc(big ? txt.slice(0, 400000) + '\n…' : txt)}</pre>`;
    const startEditor = () => {
      $('#stage').innerHTML = `<textarea id="pvT" spellcheck="false" aria-label="Contenu">${esc(txt)}</textarea>`;
      const b = $('#pvEdit'); b.innerHTML = SVG(P.check, 16) + 'Enregistrer'; b.className = 'btn btn-primary btn-sm';
      $('#pvT').focus();
      const save = async () => {
        try { await api(`api/items/${it.id}/content`, { method: 'PUT', body: $('#pvT').value, raw: true }); toast('Modifications enregistrées', 'ok'); reload(); closeModal(); }
        catch (e) { toast(e.message, 'err'); }
      };
      b.onclick = save;
      $('#pvT').onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); } };
    };
    if ($('#pvEdit')) { $('#pvEdit').onclick = startEditor; if (startEdit && !big) startEditor(); }
  }
}

/* ============================== Envoi ============================== */
function uploadList(list, parent = targetFolder()) {
  if (!list.length) return;
  if (S.view === 'trash') return toast('Impossible d\'envoyer dans la corbeille', 'err');
  if (S.view === 'drive' && !S.q && !canEdit(S.perm) && parent === S.folder) return toast('Ce dossier est en lecture seule', 'err');
  const total = list.reduce((s, f) => s + f.file.size, 0);
  if (S.me?.quota && S.me.used + total > S.me.quota && parent === 'root') return toast(`Espace insuffisant : ${fmtSize(total)} à envoyer, ${fmtSize(S.me.quota - S.me.used)} disponibles`, 'err');
  Uploader.add(list, () => `api/upload?parent=${encodeURIComponent(parent)}`, reload);
}
$('#camIn').onchange = e => { uploadList([...e.target.files].map(f => ({ file: f, path: f.name && f.name !== 'image.jpg' ? f.name : `Photo ${new Date().toLocaleString('fr-FR').replace(/[/:]/g, '-')}.jpg` }))); e.target.value = ''; };
$('#fileIn').onchange = e => { uploadList([...e.target.files].map(f => ({ file: f, path: f.name }))); e.target.value = ''; };
$('#folderIn').onchange = e => { uploadList([...e.target.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ''; };
let dragDepth = 0;
const hideDropzone = () => { dragDepth = 0; $('#dropzone').classList.remove('show'); };
const main = $('#main');
main.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files') && S.view !== 'trash' && S.view !== 'admin') { dragDepth++; $('#dropTxt').textContent = writable() ? 'Déposez vos fichiers pour les envoyer ici' : 'Déposez vos fichiers pour les envoyer dans « Mon espace »'; $('#dropzone').classList.add('show'); } });
main.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').classList.remove('show'); });
main.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
main.addEventListener('drop', async e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); hideDropzone(); if (S.view !== 'trash' && S.view !== 'admin') uploadList(await filesFromDrop(e.dataTransfer)); });
document.addEventListener('paste', e => {
  if (e.target.matches('input,textarea') || modalOpen()) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) uploadList(files.map((f, i) => ({ file: f, path: f.name === 'image.png' ? `Capture ${new Date().toLocaleString('fr-FR').replace(/[/:]/g, '-')}${i ? ' ' + i : ''}.png` : f.name })));
});

/* ============================== Évènements globaux ============================== */
$('#newBtn').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); $('#newMenu').classList.contains('show') ? hideMenus() : showNewMenu(r.left, r.bottom + 4); };
$('#fab').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); $('#newMenu').classList.contains('show') ? hideMenus() : showNewMenu(r.right - 250, r.top - 320); };
$('#userBtn').onclick = () => ($('#userMenu').classList.contains('show') ? hideMenus() : showUserMenu());
$('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; Theme.set(t); };
$('#vGrid').onclick = () => { S.layout = 'grid'; savePrefs(); render(); };
$('#vList').onclick = () => { S.layout = 'list'; savePrefs(); render(); };
$('#sort').onchange = e => { S.sort = e.target.value; savePrefs(); render(); };
$('#sortDir').onclick = () => { S.dir *= -1; savePrefs(); render(); };
$('#infoBtn').onclick = toggleDetails;
$('#burger').onclick = () => $('#side').classList.toggle('open');
$('#brandLink').onclick = e => { e.preventDefault(); go(''); };
let searchTimer;
$('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { const v = $('#q').value.trim(); if (v === S.q) return; S.q = v; load(); }, 250); });
$('#searchForm').onsubmit = e => { e.preventDefault(); clearTimeout(searchTimer); S.q = $('#q').value.trim(); load(); };
$('#content').addEventListener('click', e => { if (e.target === $('#content') || e.target.matches('.grid,.section-t,.empty,table.list')) clearSel(); });
$('#content').addEventListener('contextmenu', e => {
  if (e.target.closest('[data-id],[data-quick]') || S.view !== 'drive' || S.q) return;
  e.preventDefault(); clearSel(); showNewMenu(e.clientX, e.clientY);
});
document.addEventListener('keydown', e => {
  const inField = e.target.matches('input,textarea,select');
  if (e.key === 'Escape') { if (modalOpen()) closeModal(); else if ($('.menu.show')) hideMenus(); else clearSel(); return; }
  if (inField || modalOpen()) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'a' && S.view !== 'admin') { e.preventDefault(); S.sel = new Set(visible().map(i => i.id)); render(); }
  else if (k === '/' || (mod && k === 'k')) { e.preventDefault(); $('#q').focus(); }
  else if (e.key === 'Delete' && S.sel.size) bulk(S.view === 'trash' ? 'purge' : 'delete');
  else if (e.key === 'F2' && S.sel.size === 1 && S.view !== 'trash') { e.preventDefault(); renameDlg(byId([...S.sel][0])); }
  else if (k === 'i' && !mod) toggleDetails();
  else if (e.key === 'Backspace' && S.view === 'drive' && S.path.length) { e.preventDefault(); const p = S.path; if (p.length > 1) openFolder(p[p.length - 2].id); else go(S.root === 'shared' ? 'shared' : S.root === 'team' ? 't-' + S.team.id : ''); }
  else if (mod && k === 'x' && S.sel.size && S.view === 'drive') { S.clip = { ids: [...S.sel] }; toast(`${S.sel.size} élément(s) prêt(s) à être déplacé(s) — Ctrl+V dans le dossier de destination`); renderBody(); }
  else if (mod && k === 'v' && S.clip && writable()) { const ids = S.clip.ids; S.clip = null; api('api/move', { body: { ids, target: S.folder } }).then(r => { toast(`${r.moved} élément(s) déplacé(s)`, 'ok'); reload(); }).catch(err => toast(err.message, 'err')); }
  else if (e.key === 'Enter' && S.sel.size === 1 && !e.target.closest('[data-id]')) openItem(byId([...S.sel][0]));
});

/* ============================== Démarrage ============================== */
(async () => {
  await refreshMe();
  if (!S.me) return;
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (new URLSearchParams(location.search).has('share-target')) receiveShared();
})();
async function receiveShared() {
  history.replaceState(null, '', './' + location.hash);
  try {
    const cache = await caches.open('ed-share');
    const keys = await cache.keys();
    const list = [];
    for (const k of keys) {
      const r = await cache.match(k);
      const name = decodeURIComponent(r.headers.get('X-Name') || 'fichier');
      list.push({ file: new File([await r.blob()], name, { type: r.headers.get('Content-Type') || '' }), path: name });
      await cache.delete(k);
    }
    if (list.length) { toast(`${list.length} fichier(s) reçu(s) — envoi dans « Mon espace »`); uploadList(list, 'root'); }
  } catch (e) { toast('Impossible de récupérer les fichiers partagés', 'err'); }
}
