'use strict';
// Indexation plein texte en tâche de fond (texte, Office, OpenDocument, PDF)
const fs = require('fs');
const AdmZip = require('adm-zip');
// pdf.js (build « legacy » CommonJS) : on masque les avertissements liés au rendu, inutile ici
const _warn = console.warn, _log = console.log; console.warn = console.log = () => {};
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
console.warn = _warn; console.log = _log;
async function pdfText(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  let out = '';
  for (let i = 1; i <= Math.min(doc.numPages, 300); i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    out += c.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('') + '\n';
    if (out.length > MAX_CHARS) break;
  }
  await doc.destroy();
  return out;
}

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'js', 'ts', 'html', 'htm', 'css', 'php', 'lua', 'py', 'xml', 'yml', 'yaml', 'sql', 'log', 'ini', 'cfg', 'conf', 'sh', 'bat', 'ps1', 'rtf', 'tex', 'srt', 'vtt']);
const MAX_CHARS = 1_000_000;
const MAX_TEXT_FILE = 10 * 1024 * 1024;
const MAX_BIN_FILE = 80 * 1024 * 1024;

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
function stripXml(s) {
  return decode(s
    .replace(/<(w:tab|w:br|text:tab|text:line-break|a:br)\b[^>]*\/>/g, ' ')
    .replace(/<\/(w:p|a:p|text:p|text:h|si|row|table:table-row|c)>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
}
async function extract(file, ext) {
  const st = fs.statSync(file);
  if (TEXT_EXT.has(ext)) {
    if (st.size > MAX_TEXT_FILE) return '';
    let t = fs.readFileSync(file, 'utf8');
    if (ext === 'html' || ext === 'htm' || ext === 'xml') t = stripXml(t);
    if (ext === 'rtf') t = t.replace(/\\[a-z]+-?\d* ?|[{}]/g, ' ');
    return t;
  }
  if (st.size > MAX_BIN_FILE) return '';
  if (['docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'xltx', 'pptx', 'pptm', 'potx', 'ppsx', 'odt', 'ods', 'odp', 'ott'].includes(ext)) {
    const zip = new AdmZip(file);
    const pick = re => zip.getEntries().filter(e => re.test(e.entryName)).sort((a, b) => a.entryName.localeCompare(b.entryName, 'en', { numeric: true }));
    let entries;
    if (ext.startsWith('do')) entries = pick(/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/);
    else if (ext.startsWith('xl')) entries = pick(/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/);
    else if (ext.startsWith('p')) entries = pick(/^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/);
    else entries = pick(/^content\.xml$/);
    return entries.map(e => stripXml(e.getData().toString('utf8'))).join('\n');
  }
  if (ext === 'pdf') {
    return pdfText(fs.readFileSync(file));
  }
  return '';
}

module.exports = function createIndexer({ db, fpath, EXT }) {
  const queue = [];
  const queued = new Set();
  let running = false;
  const upsert = db.prepare('INSERT INTO fts(item_id, name, content) VALUES(?,?,?)');
  const del = db.prepare('DELETE FROM fts WHERE item_id=?');

  async function run() {
    if (running) return;
    running = true;
    while (queue.length) {
      const id = queue.shift(); queued.delete(id);
      const it = db.prepare('SELECT id,name,type FROM items WHERE id=?').get(id);
      if (!it || it.type !== 'file') { del.run(id); continue; }
      let text = '';
      try { if (fs.existsSync(fpath(id))) text = (await extract(fpath(id), EXT(it.name))).slice(0, MAX_CHARS); }
      catch (e) { /* fichier illisible ou chiffré : seul le nom est indexé */ }
      db.transaction(() => { del.run(id); upsert.run(id, it.name, text); db.prepare('UPDATE items SET indexed=1 WHERE id=?').run(id); })();
      await new Promise(r => setImmediate(r));
    }
    running = false;
  }
  function enqueue(id) { if (!queued.has(id)) { queued.add(id); queue.push(id); } setImmediate(run); }
  function remove(id) { del.run(id); }
  function rename(id, name) { db.prepare('UPDATE fts SET name=? WHERE item_id=?').run(name, id); }
  function backlog() {
    const rows = db.prepare("SELECT id FROM items WHERE type='file' AND indexed=0").all();
    rows.forEach(r => enqueue(r.id));
    if (rows.length) console.log(`Indexation plein texte : ${rows.length} fichier(s) en attente`);
  }
  // Construit une requête FTS5 sûre : chaque mot devient un préfixe entre guillemets
  function match(q) {
    const terms = String(q).split(/\s+/).map(t => t.replace(/"/g, '').trim()).filter(t => t.length >= 2).slice(0, 8);
    return terms.length ? terms.map(t => `"${t}"*`).join(' ') : null;
  }
  return { enqueue, remove, rename, backlog, match };
};
