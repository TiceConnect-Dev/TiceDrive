<?php
/* Logique métier : droits, espaces d'équipe, éléments, versions, corbeille, partage */
declare(strict_types=1);

function fpath(string $id): string { return DATA . '/files/' . $id; }
function vpath(string $id): string { return DATA . '/versions/' . $id; }
function get_item(?string $id): ?array { return $id ? q1('SELECT * FROM items WHERE id=?', [$id]) : null; }
function get_user(?string $id): ?array { return $id ? q1('SELECT * FROM users WHERE id=?', [$id]) : null; }

function ancestors(string $id): array
{
    return q('WITH RECURSIVE a(id, depth) AS (SELECT id, 0 FROM items WHERE id = ? UNION ALL SELECT i.parent_id, a.depth + 1 FROM items i JOIN a ON i.id = a.id WHERE i.parent_id IS NOT NULL)
      SELECT items.* FROM a JOIN items ON items.id = a.id ORDER BY a.depth DESC', [$id]);
}
function descendants(string $id): array
{
    return q('WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT i.id FROM items i JOIN d ON i.parent_id = d.id) SELECT items.* FROM d JOIN items ON items.id = d.id', [$id]);
}

function log_act(?string $itemId, ?array $user, string $action, ?string $detail = null): void
{
    run('INSERT INTO activity(item_id,user_id,user_name,action,detail,at) VALUES(?,?,?,?,?,?)', [$itemId, $user['id'] ?? null, $user['name'] ?? 'Invité', $action, $detail, now()]);
}

/* --- Équipes --- */
function is_team(?string $ownerId): bool { $u = get_user($ownerId); return $u && $u['kind'] === 'team'; }
function team_role(string $teamId, string $userId): ?string { $r = q1('SELECT role FROM team_members WHERE team_id=? AND user_id=?', [$teamId, $userId]); return $r['role'] ?? null; }
function my_teams(string $userId): array
{
    return q("SELECT u.id, u.name, u.quota, m.role FROM team_members m JOIN users u ON u.id=m.team_id WHERE m.user_id=? AND u.kind='team' ORDER BY u.name COLLATE NOCASE", [$userId]);
}

/* --- Noms --- */
function clean_name($n): string
{
    $n = trim(preg_replace('/\s+/u', ' ', preg_replace('/[\\\\\/:*?"<>|\x00-\x1f]/u', '', (string) $n)));
    $n = mb_substr($n, 0, 200);
    if ($n === '' || $n === '.' || $n === '..') throw E(400, 'Nom invalide');
    return $n;
}
function siblings(?string $parentId, string $ownerId): array
{
    return $parentId ? q('SELECT id,name,type FROM items WHERE parent_id=? AND trashed_at IS NULL', [$parentId])
        : q('SELECT id,name,type FROM items WHERE parent_id IS NULL AND owner_id=? AND trashed_at IS NULL', [$ownerId]);
}
function unique_name(?string $parentId, string $ownerId, string $name, ?string $exceptId = null): string
{
    $s = [];
    foreach (siblings($parentId, $ownerId) as $x) if ($x['id'] !== $exceptId) $s[mb_strtolower($x['name'])] = 1;
    if (!isset($s[mb_strtolower($name)])) return $name;
    $dot = strrpos($name, '.');
    $base = $dot > 0 ? substr($name, 0, $dot) : $name; $ext = $dot > 0 ? substr($name, $dot) : '';
    $i = 1; while (isset($s[mb_strtolower("$base ($i)$ext")])) $i++;
    return "$base ($i)$ext";
}

/* --- Droits : owner > edit > view --- */
function perm(?array $user, ?array $item): ?string
{
    if (!$item || !$user || empty($user['id'])) return null;
    if ($item['owner_id'] === $user['id']) return 'owner';
    $best = null;
    if (is_team($item['owner_id'])) { $r = team_role($item['owner_id'], $user['id']); if ($r === 'manager') return 'owner'; $best = ROLE_PERM[$r] ?? null; }
    if ($best === 'edit') return $best;
    $ids = array_column(ancestors($item['id']), 'id');
    $rows = q('SELECT perm FROM access WHERE user_id=? AND item_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')', array_merge([$user['id']], $ids));
    foreach ($rows as $r) if ($r['perm'] === 'edit') return 'edit';
    if ($rows) return 'view';
    return $best;
}
function can_edit(?string $p): bool { return $p === 'owner' || $p === 'edit'; }
function need(array $user, $id, string $level = 'view'): array
{
    $it = get_item((string) $id);
    if (!$it) throw E(404, 'Élément introuvable');
    $p = perm($user, $it);
    if (!$p) throw E(404, 'Élément introuvable');
    if ($level === 'edit' && !can_edit($p)) throw E(403, 'Droits insuffisants');
    if ($level === 'owner' && $p !== 'owner') throw E(403, 'Seul le propriétaire peut faire cela');
    $it['perm'] = $p;
    return $it;
}

/* --- Quota --- */
function used(string $owner): int
{
    $r = q1('SELECT COALESCE((SELECT SUM(size) FROM items WHERE owner_id=?),0) + COALESCE((SELECT SUM(v.size) FROM versions v JOIN items i ON i.id=v.item_id WHERE i.owner_id=?),0) AS u', [$owner, $owner]);
    return (int) $r['u'];
}
function check_quota(string $ownerId, int $add): void
{
    $u = get_user($ownerId);
    if ($u && $u['quota'] > 0 && used($ownerId) + $add > $u['quota']) throw E(413, 'Quota de stockage dépassé');
}

/* --- Création / stockage --- */
function create_item(array $o): array
{
    $id = uid(); $t = now();
    $n = unique_name($o['parent'] ?? null, $o['owner'], clean_name($o['name']));
    run('INSERT INTO items(id,owner_id,parent_id,type,name,size,mime,version,created,modified,modified_by) VALUES(?,?,?,?,?,?,?,1,?,?,?)',
        [$id, $o['owner'], $o['parent'] ?? null, $o['type'], $n, $o['size'] ?? 0, $o['mime'] ?? null, $t, $t, $o['by'] ?? null]);
    return get_item($id);
}
function move_file(string $src, string $dst): void
{
    if (is_uploaded_file($src)) { if (!move_uploaded_file($src, $dst)) throw E(500, "Impossible d'enregistrer le fichier"); return; }
    if (!@rename($src, $dst)) { copy($src, $dst); @unlink($src); }
}
function resolve_parent(array $user, $parentId): array
{
    $parentId = (string) ($parentId ?? '');
    if ($parentId === '' || $parentId === 'root') return ['owner' => $user['id'], 'parent' => null];
    if (str_starts_with($parentId, 'team:')) {
        $tid = substr($parentId, 5); $r = team_role($tid, $user['id']);
        if (!$r || !is_team($tid)) throw E(404, 'Espace introuvable');
        if (!can_edit(ROLE_PERM[$r])) throw E(403, 'Vous êtes en lecture seule dans cet espace');
        return ['owner' => $tid, 'parent' => null];
    }
    $f = need($user, $parentId, 'edit');
    if ($f['type'] !== 'folder' || $f['trashed_at']) throw E(400, 'Dossier de destination invalide');
    return ['owner' => $f['owner_id'], 'parent' => $f['id']];
}
function ensure_folder_path(?string $parent, string $owner, array $segs, ?array $user): ?string
{
    $p = $parent;
    foreach ($segs as $raw) {
        $name = clean_name($raw); $found = null;
        foreach (siblings($p, $owner) as $s) if ($s['type'] === 'folder' && mb_strtolower($s['name']) === mb_strtolower($name)) { $found = $s['id']; break; }
        $p = $found ?: create_item(['owner' => $owner, 'parent' => $p, 'type' => 'folder', 'name' => $name, 'by' => $user['name'] ?? null])['id'];
    }
    return $p;
}
/** $files : liste de ['tmp' => chemin, 'path' => chemin relatif, 'size' => int, 'type' => mime navigateur] */
function store_uploads(array $files, string $owner, ?string $parent, ?array $user): array
{
    $total = array_sum(array_column($files, 'size'));
    try { check_quota($owner, $total); } catch (HttpError $e) { foreach ($files as $f) @unlink($f['tmp']); throw $e; }
    $out = [];
    foreach ($files as $f) {
        $segs = array_values(array_filter(array_map('trim', explode('/', str_replace('\\', '/', $f['path']))), 'strlen'));
        $fname = array_pop($segs) ?: 'fichier';
        $p = $segs ? ensure_folder_path($parent, $owner, $segs, $user) : $parent;
        $type = ($f['type'] && $f['type'] !== 'application/octet-stream') ? $f['type'] : mime_of($fname);
        $it = create_item(['owner' => $owner, 'parent' => $p, 'type' => 'file', 'name' => $fname, 'size' => $f['size'], 'mime' => $type, 'by' => $user['name'] ?? 'Invité']);
        move_file($f['tmp'], fpath($it['id']));
        log_act($it['id'], $user, 'upload');
        index_later($it['id']);
        $out[] = $it;
    }
    return $out;
}
/** $data : contenu (string) ou ['path' => fichier temporaire à déplacer] */
function save_new_version(array $item, $data, string $author, ?string $newExt = null): array
{
    $vid = uid();
    if (is_file(fpath($item['id'])) && $item['size'] > 0) {
        copy(fpath($item['id']), vpath($vid));
        run('INSERT INTO versions(id,item_id,version,size,created,author) VALUES(?,?,?,?,?,?)', [$vid, $item['id'], $item['version'], $item['size'], $item['modified'], $item['modified_by']]);
    }
    if (is_array($data)) { $size = filesize($data['path']); move_file($data['path'], fpath($item['id'])); }
    else { file_put_contents(fpath($item['id']), $data); $size = strlen($data); }
    $name = $item['name'];
    if ($newExt && $newExt !== ext($name)) $name = unique_name($item['parent_id'], $item['owner_id'], preg_replace('/\.[^.]+$/', '', $name) . '.' . $newExt, $item['id']);
    run('UPDATE items SET size=?, version=version+1, modified=?, modified_by=?, name=?, indexed=0 WHERE id=?', [$size, now(), $author, $name, $item['id']]);
    foreach (q('SELECT id FROM versions WHERE item_id=? ORDER BY version DESC LIMIT -1 OFFSET ?', [$item['id'], max_versions()]) as $v) {
        @unlink(vpath($v['id'])); run('DELETE FROM versions WHERE id=?', [$v['id']]);
    }
    index_later($item['id']);
    return get_item($item['id']);
}

/* --- Corbeille --- */
function trash_item(array $it): void
{
    $t = now();
    tx(function () use ($it, $t) {
        foreach (descendants($it['id']) as $d) if ($d['id'] === $it['id'] || !$d['trashed_at']) run('UPDATE items SET trashed_at=?, trash_root=? WHERE id=?', [$t, $d['id'] === $it['id'] ? 1 : 0, $d['id']]);
    });
}
function restore_item(array $it): void
{
    $parent = $it['parent_id'];
    $p = get_item($parent);
    if ($parent && (!$p || $p['trashed_at'])) $parent = null;
    tx(function () use ($it, $parent) {
        foreach (descendants($it['id']) as $d) if ($d['trashed_at'] === $it['trashed_at']) run('UPDATE items SET trashed_at=NULL, trash_root=0 WHERE id=?', [$d['id']]);
        run('UPDATE items SET parent_id=?, name=? WHERE id=?', [$parent, unique_name($parent, $it['owner_id'], $it['name'], $it['id']), $it['id']]);
    });
}
function purge_item(array $it): void
{
    foreach (descendants($it['id']) as $d) {
        @unlink(fpath($d['id']));
        index_remove($d['id']);
        foreach (q('SELECT id FROM versions WHERE item_id=?', [$d['id']]) as $v) @unlink(vpath($v['id']));
    }
    run('DELETE FROM items WHERE id=?', [$it['id']]);
}

/* --- Copie / déplacement --- */
function copy_tree(array $it, ?string $parent, string $owner, array $user, bool $rename, ?string $forced = null): array
{
    $name = $forced ?: ($rename ? (function () use ($it) { $d = strrpos($it['name'], '.'); return $it['type'] === 'file' && $d > 0 ? substr($it['name'], 0, $d) . ' - copie' . substr($it['name'], $d) : $it['name'] . ' - copie'; })() : $it['name']);
    $n = create_item(['owner' => $owner, 'parent' => $parent, 'type' => $it['type'], 'name' => $name, 'size' => $it['size'], 'mime' => $it['mime'], 'by' => $user['name']]);
    if ($it['color']) run('UPDATE items SET color=? WHERE id=?', [$it['color'], $n['id']]);
    if ($it['type'] === 'file') { if (is_file(fpath($it['id']))) copy(fpath($it['id']), fpath($n['id'])); index_later($n['id']); }
    else foreach (q('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL', [$it['id']]) as $c) copy_tree($c, $n['id'], $owner, $user, false);
    return $n;
}
function move_item(array $user, array $it, array $dest, ?string $newName = null): array
{
    if ($dest['parent'] && ($dest['parent'] === $it['id'] || in_array($it['id'], array_column(ancestors($dest['parent']), 'id'), true))) throw E(400, 'Impossible de déplacer un dossier dans lui-même');
    $name = $newName ? clean_name($newName) : $it['name'];
    if ($it['owner_id'] !== $dest['owner']) {
        if (perm($user, $it) !== 'owner') throw E(403, "Seul le propriétaire peut déplacer « {$it['name']} » vers un autre espace (utilisez Copier)");
        $desc = descendants($it['id']);
        check_quota($dest['owner'], array_sum(array_column($desc, 'size')));
        tx(function () use ($desc, $dest) { foreach ($desc as $d) run('UPDATE items SET owner_id=? WHERE id=?', [$dest['owner'], $d['id']]); });
    }
    $final = unique_name($dest['parent'], $dest['owner'], $name, $it['id']);
    run('UPDATE items SET parent_id=?, name=?, modified=? WHERE id=?', [$dest['parent'], $final, now(), $it['id']]);
    if ($final !== $it['name']) index_rename($it['id'], $final);
    return get_item($it['id']);
}

/* --- Sérialisation --- */
function list_sql(string $where): string
{
    return "SELECT i.*, u.name AS owner_name, u.kind AS owner_kind,
      EXISTS(SELECT 1 FROM stars s WHERE s.item_id=i.id AND s.user_id=:uid) AS starred,
      (EXISTS(SELECT 1 FROM links l WHERE l.item_id=i.id) OR EXISTS(SELECT 1 FROM access a WHERE a.item_id=i.id)) AS shared,
      (SELECT COUNT(*) FROM items c WHERE c.parent_id=i.id AND c.trashed_at IS NULL) AS children,
      (SELECT COUNT(*) FROM comments k WHERE k.item_id=i.id) AS comments
      FROM items i JOIN users u ON u.id=i.owner_id WHERE $where";
}
function ser(array $it, ?array $user, array $extra = []): array
{
    return array_merge([
        'id' => $it['id'], 'name' => $it['name'], 'type' => $it['type'], 'size' => (int) $it['size'], 'mime' => $it['mime'], 'ext' => $it['type'] === 'file' ? ext($it['name']) : '',
        'version' => (int) $it['version'], 'description' => $it['description'] ?? '', 'starred' => !empty($it['starred']), 'shared' => !empty($it['shared']), 'color' => $it['color'] ?? null,
        'children' => (int) ($it['children'] ?? 0), 'comments' => (int) ($it['comments'] ?? 0), 'created' => (int) $it['created'], 'modified' => (int) $it['modified'], 'modified_by' => $it['modified_by'],
        'trashed_at' => $it['trashed_at'] !== null ? (int) $it['trashed_at'] : null, 'owner_name' => $it['owner_name'] ?? null, 'owner_id' => $it['owner_id'],
        'team' => ($it['owner_kind'] ?? '') === 'team', 'mine' => $user ? $it['owner_id'] === $user['id'] : false, 'parent_id' => $it['parent_id'],
    ], $extra);
}
function item_row(array $user, string $id): ?array { return q1(list_sql('i.id=:id'), ['uid' => $user['id'], 'id' => $id]); }
function visible_path(array $user, string $itemId, bool $includeSelf = true): array
{
    $all = ancestors($itemId);
    $anc = $includeSelf ? $all : array_slice($all, 0, -1);
    $top = $all[0] ?? null;
    $P = fn($a) => ['id' => $a['id'], 'name' => $a['name']];
    if (!$top) return ['root' => 'drive', 'path' => []];
    if ($top['owner_id'] === $user['id']) return ['root' => 'drive', 'path' => array_map($P, $anc)];
    if (is_team($top['owner_id']) && team_role($top['owner_id'], $user['id'])) {
        $t = get_user($top['owner_id']);
        return ['root' => 'team', 'team' => ['id' => $t['id'], 'name' => $t['name'], 'role' => team_role($t['id'], $user['id'])], 'path' => array_map($P, $anc)];
    }
    $ids = array_flip(array_column(q('SELECT item_id FROM access WHERE user_id=?', [$user['id']]), 'item_id'));
    $k = -1;
    foreach ($anc as $i => $a) if (isset($ids[$a['id']])) { $k = $i; break; }
    return ['root' => 'shared', 'path' => $k < 0 ? [] : array_map($P, array_slice($anc, $k))];
}
function root_label(array $vp): string { return $vp['root'] === 'drive' ? 'Mon espace' : ($vp['root'] === 'team' ? $vp['team']['name'] : 'Partagés avec moi'); }
function with_location(array $user, array $rows, ?callable $extra = null): array
{
    return array_map(function ($r) use ($user, $extra) {
        $vp = visible_path($user, $r['id'], false);
        return ser($r, $user, array_merge(['location' => implode(' / ', array_merge([root_label($vp)], array_column($vp['path'], 'name'))), 'perm' => perm($user, $r)], $extra ? $extra($r) : []));
    }, $rows);
}

/* --- Envoi de fichiers (avec gestion des plages pour les vidéos) --- */
function send_file(string $file, string $name, ?string $mime, bool $download, array $extraHeaders = []): void
{
    if (!is_file($file)) throw E(404, 'Fichier absent du stockage');
    $type = $mime ?: mime_of($name);
    if (!$download && preg_match('/html|svg|xml|javascript|ecmascript/i', $type)) $type = 'text/plain; charset=utf-8';
    elseif (str_starts_with($type, 'text/') && !str_contains($type, 'charset')) $type .= '; charset=utf-8';
    $size = filesize($file);
    $mtime = filemtime($file);
    $etag = '"' . dechex($size) . '-' . dechex($mtime) . '"';
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: ' . $type);
    header('Content-Disposition: ' . content_disposition($name, $download));
    header('X-Content-Type-Options: nosniff');
    header('Accept-Ranges: bytes');
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    header('Cache-Control: private, max-age=0, must-revalidate');
    if (!str_contains($type, 'pdf')) header("Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    foreach ($extraHeaders as $k => $v) header("$k: $v");
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); return; }
    $start = 0; $end = $size - 1;
    if (isset($_SERVER['HTTP_RANGE']) && preg_match('/bytes=(\d*)-(\d*)/', $_SERVER['HTTP_RANGE'], $m) && $size > 0) {
        if ($m[1] === '') { $start = max(0, $size - (int) $m[2]); }
        else { $start = (int) $m[1]; if ($m[2] !== '') $end = min($end, (int) $m[2]); }
        if ($start > $end || $start >= $size) { http_response_code(416); header("Content-Range: bytes */$size"); return; }
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    }
    header('Content-Length: ' . ($end - $start + 1));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') return;
    $fh = fopen($file, 'rb'); fseek($fh, $start);
    $left = $end - $start + 1;
    @set_time_limit(0);
    while ($left > 0 && !feof($fh) && !connection_aborted()) { $chunk = fread($fh, (int) min(1 << 20, $left)); echo $chunk; $left -= strlen($chunk); flush(); }
    fclose($fh);
}
function content_disposition(string $name, bool $download): string
{
    $fallback = preg_replace('/[^\x20-\x7e]|["\\\\]/', '_', $name);
    return ($download ? 'attachment' : 'inline') . '; filename="' . $fallback . '"; filename*=UTF-8\'\'' . rawurlencode($name);
}
function zip_to_output(array $roots, string $filename): void
{
    if (!class_exists('ZipArchive')) throw E(501, "L'extension PHP zip n'est pas installée sur ce serveur");
    @set_time_limit(0);
    $tmp = DATA . '/tmp/zip-' . uid() . '.zip';
    $z = new ZipArchive();
    $z->open($tmp, ZipArchive::CREATE);
    $add = function ($it, $prefix) use (&$add, $z) {
        if ($it['trashed_at']) return;
        if ($it['type'] === 'file') { if (is_file(fpath($it['id']))) { $z->addFile(fpath($it['id']), $prefix . $it['name']); if (method_exists($z, 'setCompressionName')) $z->setCompressionName($prefix . $it['name'], ZipArchive::CM_DEFLATE); } return; }
        $kids = q('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL', [$it['id']]);
        if (!$kids) $z->addEmptyDir($prefix . $it['name']);
        foreach ($kids as $c) $add($c, $prefix . $it['name'] . '/');
    };
    foreach ($roots as $r) $add($r, '');
    if ($z->numFiles === 0) $z->addFromString('LISEZMOI.txt', 'Dossier vide');
    $z->close();
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: application/zip');
    header('Content-Disposition: ' . content_disposition($filename, true));
    header('Content-Length: ' . filesize($tmp));
    readfile($tmp);
    @unlink($tmp);
}

/* --- Maintenance (lancée de temps en temps, sans tâche planifiée) --- */
function maintenance(): void
{
    $last = (int) setting('last_maintenance', '0');
    if (now() - $last < 3 * 3600 * 1000) return;
    set_setting('last_maintenance', (string) now());
    $limit = now() - trash_days() * 86400000;
    foreach (q('SELECT * FROM items WHERE trash_root=1 AND trashed_at < ?', [$limit]) as $it) purge_item($it);
    run('DELETE FROM links WHERE expires IS NOT NULL AND expires < ?', [now() - 30 * 86400000]);
    run('DELETE FROM activity WHERE at < ?', [now() - 365 * 86400000]);
    run('DELETE FROM attempts WHERE until < ? AND at < ?', [now(), now() - 86400000]);
    foreach (glob(DATA . '/tmp/*') ?: [] as $f) if (filemtime($f) < time() - 86400) @unlink($f);
}

/* --- Compte admin initial depuis config.php --- */
function ensure_admin_from_config(): void
{
    global $CFG;
    if ($CFG['admin_email'] && $CFG['admin_password'] && !q1('SELECT 1 AS x FROM users WHERE email=?', [$CFG['admin_email']])) {
        run('INSERT INTO users(id,email,name,password,role,quota,created) VALUES(?,?,?,?,?,?,?)', [uid(), strtolower($CFG['admin_email']), 'Administrateur', password_hash($CFG['admin_password'], PASSWORD_DEFAULT), 'admin', 0, now()]);
    }
}
