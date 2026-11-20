<?php
/* Routes HTTP : authentification, API, liens publics, OnlyOffice */
declare(strict_types=1);

/* ============================== Routeur ============================== */
$GLOBALS['ROUTES'] = [];
function route(string $method, string $pattern, callable $h): void
{
    $re = '#^' . preg_replace('#:([a-z_]+)#', '(?P<$1>[^/]+)', $pattern) . '$#';
    $GLOBALS['ROUTES'][] = [$method, $re, $h];
}
function dispatch(string $method, string $path): bool
{
    foreach ($GLOBALS['ROUTES'] as [$m, $re, $h]) {
        if ($m !== $method && !($m === 'GET' && $method === 'HEAD')) continue;
        if (preg_match($re, $path, $mm)) {
            $params = array_map('rawurldecode', array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY));
            $h($params);
            return true;
        }
    }
    return false;
}

/* ============================== Session ============================== */
const COOKIE = 'ed_sess';
function cookie_opts(int $ttl): array { return ['expires' => $ttl ? time() + $ttl : 0, 'path' => base_path() . '/', 'secure' => is_https(), 'httponly' => true, 'samesite' => 'Lax']; }
function set_session(array $u): void { setcookie(COOKIE, jwt_sign(['uid' => $u['id']], SECRET, 30 * 86400), cookie_opts(30 * 86400)); }
function current_user(): ?array
{
    static $u = false;
    if ($u !== false) return $u;
    $p = jwt_verify($_COOKIE[COOKIE] ?? null, SECRET);
    $x = $p ? get_user($p['uid'] ?? '') : null;
    return $u = ($x && !$x['disabled'] && $x['kind'] === 'user') ? $x : null;
}
function me(): array { $u = current_user(); if (!$u) throw E(401, 'Session expirée, reconnectez-vous'); return $u; }
function need_admin(): array { $u = me(); if ($u['role'] !== 'admin') throw E(403, 'Réservé aux administrateurs'); return $u; }
function pub_user(array $u): array
{
    return ['id' => $u['id'], 'email' => $u['email'], 'name' => $u['name'], 'role' => $u['role'], 'quota' => (int) $u['quota'], 'disabled' => (bool) $u['disabled'],
        'created' => (int) $u['created'], 'last_login' => $u['last_login'] ? (int) $u['last_login'] : null, 'totp' => !empty($u['totp_secret'])];
}
function user_count(): int { return (int) q1("SELECT COUNT(*) AS c FROM users WHERE kind='user'")['c']; }
function signup_open(): bool { return user_count() === 0 || conf('allow_signup') === '1'; }

/* ============================== OnlyOffice ============================== */
const OO_TYPES = [
    'word' => ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'ott', 'rtf', 'txt', 'mht', 'epub', 'fb2', 'djvu', 'xps', 'oxps'],
    'cell' => ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'ods', 'ots', 'csv'],
    'slide' => ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'potm', 'odp', 'otp'],
    'pdf' => ['pdf'],
];
const OO_EDIT = ['docx', 'docm', 'dotx', 'odt', 'rtf', 'xlsx', 'xlsm', 'xltx', 'ods', 'csv', 'pptx', 'pptm', 'potx', 'odp'];
function doc_type(string $ext): ?string { foreach (OO_TYPES as $k => $v) if (in_array($ext, $v, true)) return $k; return null; }
function oo_info(): ?array { return oo_url() ? ['edit' => OO_EDIT, 'view' => array_merge(...array_values(OO_TYPES))] : null; }
function oo_config(array $item, array $user, string $mode, string $fileUrl, string $callbackUrl, ?string $backUrl): array
{
    $ext = ext($item['name']);
    $c = [
        'document' => ['fileType' => $ext, 'key' => $item['id'] . '-' . $item['version'], 'title' => $item['name'], 'url' => $fileUrl,
            'permissions' => ['edit' => $mode === 'edit', 'download' => true, 'print' => true, 'comment' => $mode === 'edit', 'review' => $mode === 'edit', 'fillForms' => $mode === 'edit']],
        'documentType' => doc_type($ext),
        'editorConfig' => ['mode' => $mode, 'lang' => 'fr', 'region' => 'fr-FR', 'callbackUrl' => $callbackUrl, 'user' => ['id' => $user['id'], 'name' => $user['name']],
            'customization' => array_filter(['forcesave' => true, 'autosave' => true, 'compactHeader' => false, 'goback' => $backUrl ? ['url' => $backUrl, 'text' => 'Retour au drive', 'blank' => false] : null], fn($v) => $v !== null)],
    ];
    if (oo_secret()) $c['token'] = jwt_sign($c, oo_secret());
    return $c;
}
function ds_urls(array $item, ?string $share = null): array
{
    $ft = jwt_sign(['fid' => $item['id'], 'k' => 'file'], SECRET, 86400);
    $ct = jwt_sign(['fid' => $item['id'], 'k' => 'cb', 'share' => $share], SECRET, 7 * 86400);
    return [ds_base() . '/oo/file/' . $item['id'] . '?t=' . $ft, ds_base() . '/oo/callback/' . $item['id'] . '?t=' . $ct];
}

/* ============================== Envois (y compris par morceaux) ============================== */
function collect_uploads(string $scope): ?array
{
    if (empty($_FILES['files'])) {
        $cl = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($cl > ini_bytes((string) ini_get('post_max_size'))) throw E(413, 'Envoi trop volumineux pour ce serveur');
        return [];
    }
    $F = $_FILES['files'];
    $list = [];
    if (is_array($F['name'])) { foreach ($F['name'] as $i => $n) $list[] = ['name' => $n, 'tmp' => $F['tmp_name'][$i], 'size' => $F['size'][$i], 'type' => $F['type'][$i], 'error' => $F['error'][$i]]; }
    else $list[] = ['name' => $F['name'], 'tmp' => $F['tmp_name'], 'size' => $F['size'], 'type' => $F['type'], 'error' => $F['error']];
    $paths = $_POST['paths'] ?? []; if (!is_array($paths)) $paths = [$paths];
    foreach ($list as $f) {
        if ($f['error'] === UPLOAD_ERR_INI_SIZE || $f['error'] === UPLOAD_ERR_FORM_SIZE) throw E(413, 'Fichier trop volumineux pour ce serveur');
        if ($f['error'] !== UPLOAD_ERR_OK) throw E(400, "Échec de l'envoi (code {$f['error']})");
    }
    if (isset($_POST['chunk_id'])) {
        $f = $list[0];
        $cid = preg_replace('/[^a-zA-Z0-9-]/', '', (string) $_POST['chunk_id']);
        $idx = (int) ($_POST['chunk_index'] ?? 0); $tot = max(1, (int) ($_POST['chunk_total'] ?? 1));
        $tmp = DATA . '/tmp/chunk-' . hash('sha256', $scope . '|' . $cid);
        if ($idx === 0) @unlink($tmp);
        elseif (!is_file($tmp) || (int) @file_get_contents($tmp . '.n') !== $idx) throw E(409, "Morceau inattendu, recommencez l'envoi");
        $in = fopen($f['tmp'], 'rb'); $out = fopen($tmp, 'ab'); stream_copy_to_stream($in, $out); fclose($in); fclose($out);
        @unlink($f['tmp']);
        file_put_contents($tmp . '.n', (string) ($idx + 1));
        if ($idx < $tot - 1) return null;
        @unlink($tmp . '.n');
        return [['tmp' => $tmp, 'path' => (string) ($paths[0] ?? $f['name']), 'size' => filesize($tmp), 'type' => $f['type']]];
    }
    $out = [];
    foreach ($list as $i => $f) $out[] = ['tmp' => $f['tmp'], 'path' => (string) ($paths[$i] ?? $f['name']), 'size' => (int) $f['size'], 'type' => $f['type']];
    return $out;
}
function discard_uploads(): void
{
    if (empty($_FILES['files'])) return;
    foreach ((array) $_FILES['files']['tmp_name'] as $t) @unlink($t);
}

/* ============================== Authentification ============================== */
route('GET', '/api/config', function () {
    json_out(['appName' => app_name(), 'signup' => signup_open(), 'firstRun' => user_count() === 0, 'onlyoffice' => (bool) oo_url()]);
});
route('POST', '/api/login', function () {
    $email = trim((string) input('email', ''));
    $key = 'login|' . client_ip() . '|' . strtolower($email);
    throttle($key);
    $u = q1("SELECT * FROM users WHERE email=? AND kind='user'", [$email]);
    if (!$u || !password_verify((string) input('password', ''), $u['password'])) { failed($key); throw E(401, 'Adresse e-mail ou mot de passe incorrect'); }
    if ($u['disabled']) throw E(403, 'Ce compte est désactivé');
    attempts_clear($key);
    if ($u['totp_secret']) { json_out(['need2fa' => true, 'ticket' => jwt_sign(['uid' => $u['id'], 'k' => '2fa'], SECRET, 300)]); return; }
    run('UPDATE users SET last_login=? WHERE id=?', [now(), $u['id']]);
    set_session($u);
    json_out(['ok' => true]);
});
route('POST', '/api/login/2fa', function () {
    $p = jwt_verify((string) input('ticket', ''), SECRET);
    if (!$p || ($p['k'] ?? '') !== '2fa') throw E(401, 'Délai dépassé, reconnectez-vous');
    $key = '2fa|' . $p['uid']; throttle($key);
    $u = get_user($p['uid']);
    if (!$u || $u['disabled'] || !$u['totp_secret']) throw E(401, 'Compte invalide');
    $code = trim((string) input('code', ''));
    $ok = totp_verify($u['totp_secret'], $code);
    if (!$ok && preg_match('/[a-z0-9]{4}-?[a-z0-9]{4}/i', $code)) {
        $list = json_decode($u['recovery'] ?: '[]', true); $h = hash('sha256', preg_replace('/[^a-z0-9]/', '', strtolower($code)));
        if (in_array($h, $list, true)) { $ok = true; run('UPDATE users SET recovery=? WHERE id=?', [json_encode(array_values(array_diff($list, [$h]))), $u['id']]); }
    }
    if (!$ok) { failed($key); throw E(401, 'Code incorrect'); }
    attempts_clear($key);
    run('UPDATE users SET last_login=? WHERE id=?', [now(), $u['id']]);
    set_session($u);
    json_out(['ok' => true]);
});
route('POST', '/api/register', function () {
    $first = user_count() === 0;
    if (!signup_open()) throw E(403, 'Les inscriptions sont fermées');
    $email = strtolower(trim((string) input('email', ''))); $name = mb_substr(trim((string) input('name', '')), 0, 80); $pw = (string) input('password', '');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw E(400, 'Adresse e-mail invalide');
    if ($name === '') throw E(400, 'Le nom est obligatoire');
    if (strlen($pw) < 8) throw E(400, 'Le mot de passe doit contenir au moins 8 caractères');
    if (q1('SELECT 1 AS x FROM users WHERE email=?', [$email])) throw E(409, 'Un compte existe déjà avec cette adresse');
    $u = ['id' => uid(), 'email' => $email, 'name' => $name, 'password' => password_hash($pw, PASSWORD_DEFAULT), 'role' => $first ? 'admin' : 'user', 'quota' => $first ? 0 : default_quota(), 'created' => now()];
    run('INSERT INTO users(id,email,name,password,role,quota,created) VALUES(:id,:email,:name,:password,:role,:quota,:created)', $u);
    set_session($u);
    json_out(['ok' => true]);
});
route('POST', '/api/logout', function () { setcookie(COOKIE, '', cookie_opts(-3600)); json_out(['ok' => true]); });

/* ============================== Compte ============================== */
route('GET', '/api/me', function () {
    $u = me();
    $cat = ['documents' => 0, 'images' => 0, 'videos' => 0, 'audio' => 0, 'archives' => 0, 'autres' => 0]; $files = 0;
    foreach (q("SELECT mime, name, size FROM items WHERE owner_id=? AND type='file'", [$u['id']]) as $f) {
        $m = $f['mime'] ?? ''; $e = ext($f['name']); $files += $f['size'];
        if (str_starts_with($m, 'image/')) $cat['images'] += $f['size'];
        elseif (str_starts_with($m, 'video/')) $cat['videos'] += $f['size'];
        elseif (str_starts_with($m, 'audio/')) $cat['audio'] += $f['size'];
        elseif (in_array($e, ['zip', 'rar', '7z', 'tar', 'gz'], true)) $cat['archives'] += $f['size'];
        elseif (doc_type($e) || str_starts_with($m, 'text/')) $cat['documents'] += $f['size'];
        else $cat['autres'] += $f['size'];
    }
    $used = used($u['id']);
    json_out(['user' => pub_user($u), 'used' => $used, 'quota' => (int) $u['quota'], 'breakdown' => $cat + ['versions' => $used - $files],
        'appName' => app_name(), 'appUrl' => app_url(), 'onlyoffice' => oo_info(), 'trashDays' => trash_days(), 'chunkSize' => chunk_size(),
        'teams' => array_map(fn($t) => $t + ['used' => used($t['id'])], my_teams($u['id']))]);
});
route('PATCH', '/api/me', function () {
    $u = me();
    if (input('name') !== null) { $n = mb_substr(trim((string) input('name')), 0, 80); if ($n === '') throw E(400, 'Nom invalide'); run('UPDATE users SET name=? WHERE id=?', [$n, $u['id']]); }
    if (input('password')) {
        if (!password_verify((string) input('current', ''), $u['password'])) throw E(400, 'Mot de passe actuel incorrect');
        if (strlen((string) input('password')) < 8) throw E(400, 'Le nouveau mot de passe doit contenir au moins 8 caractères');
        run('UPDATE users SET password=? WHERE id=?', [password_hash((string) input('password'), PASSWORD_DEFAULT), $u['id']]);
    }
    json_out(['ok' => true]);
});
route('POST', '/api/me/2fa/setup', function () {
    $u = me();
    if ($u['totp_secret']) throw E(400, 'La double authentification est déjà activée');
    $s = totp_secret();
    run('UPDATE users SET totp_pending=? WHERE id=?', [$s, $u['id']]);
    json_out(['secret' => $s, 'uri' => totp_uri($s, $u['email'], app_name())]);
});
route('POST', '/api/me/2fa/enable', function () {
    $u = get_user(me()['id']);
    if (!$u['totp_pending']) throw E(400, 'Commencez par scanner le QR code');
    if (!totp_verify($u['totp_pending'], input('code'))) throw E(400, "Code incorrect — vérifiez l'heure de votre téléphone");
    $codes = []; for ($i = 0; $i < 8; $i++) { $s = substr(bin2hex(random_bytes(5)), 0, 8); $codes[] = substr($s, 0, 4) . '-' . substr($s, 4); }
    run('UPDATE users SET totp_secret=?, totp_pending=NULL, recovery=? WHERE id=?', [$u['totp_pending'], json_encode(array_map(fn($c) => hash('sha256', str_replace('-', '', $c)), $codes)), $u['id']]);
    json_out(['codes' => $codes]);
});
route('POST', '/api/me/2fa/disable', function () {
    $u = me();
    if (!password_verify((string) input('password', ''), $u['password'])) throw E(400, 'Mot de passe incorrect');
    run('UPDATE users SET totp_secret=NULL, totp_pending=NULL, recovery=NULL WHERE id=?', [$u['id']]);
    json_out(['ok' => true]);
});
route('GET', '/api/me/app-passwords', function () {
    $u = me();
    json_out(['davUrl' => app_url() . '/dav/', 'items' => q('SELECT id, name, created, last_used FROM app_passwords WHERE user_id=? ORDER BY created DESC', [$u['id']])]);
});
route('POST', '/api/me/app-passwords', function () {
    $u = me();
    $name = mb_substr(trim((string) input('name', '')), 0, 60) ?: 'Appareil';
    $pw = implode('-', str_split(substr(strtolower(preg_replace('/[^a-z0-9]/i', '', base64_encode(random_bytes(24)))), 0, 16), 4));
    run('INSERT INTO app_passwords(id,user_id,name,hash,created) VALUES(?,?,?,?,?)', [uid(), $u['id'], $name, password_hash($pw, PASSWORD_DEFAULT), now()]);
    json_out(['password' => $pw, 'login' => $u['email'], 'davUrl' => app_url() . '/dav/']);
});
route('DELETE', '/api/me/app-passwords/:id', function ($p) { $u = me(); run('DELETE FROM app_passwords WHERE id=? AND user_id=?', [$p['id'], $u['id']]); json_out(['ok' => true]); });
function check_app_password(array $u, string $pw): bool
{
    $pw = strtolower(trim($pw));
    foreach (q('SELECT * FROM app_passwords WHERE user_id=?', [$u['id']]) as $r) if (password_verify($pw, $r['hash'])) { run('UPDATE app_passwords SET last_used=? WHERE id=?', [now(), $r['id']]); return true; }
    return false;
}

/* ============================== Listes ============================== */
route('GET', '/api/folder/:id', function ($p) {
    $u = me(); $id = $p['id']; $folder = null; $perm = 'owner';
    if ($id === 'root') {
        $rows = q(list_sql('i.parent_id IS NULL AND i.owner_id=:uid AND i.trashed_at IS NULL'), ['uid' => $u['id']]);
        $vp = ['root' => 'drive', 'path' => []];
    } elseif (str_starts_with($id, 'team:')) {
        $tid = substr($id, 5); $role = team_role($tid, $u['id']);
        if (!$role || !is_team($tid)) throw E(404, 'Espace introuvable');
        $t = get_user($tid); $perm = ROLE_PERM[$role];
        $rows = q(list_sql('i.parent_id IS NULL AND i.owner_id=:tid AND i.trashed_at IS NULL'), ['uid' => $u['id'], 'tid' => $tid]);
        $vp = ['root' => 'team', 'team' => ['id' => $t['id'], 'name' => $t['name'], 'role' => $role, 'quota' => (int) $t['quota'], 'used' => used($t['id'])], 'path' => []];
    } else {
        $folder = need($u, $id);
        if ($folder['type'] !== 'folder') throw E(400, "Ce n'est pas un dossier");
        if ($folder['trashed_at']) throw E(404, 'Ce dossier est dans la corbeille');
        $perm = $folder['perm'];
        $rows = q(list_sql('i.parent_id=:pid AND i.trashed_at IS NULL'), ['uid' => $u['id'], 'pid' => $folder['id']]);
        $vp = visible_path($u, $folder['id']);
    }
    json_out(['folder' => $folder ? ser($folder, $u) : null, 'perm' => $perm, 'root' => $vp['root'], 'team' => $vp['team'] ?? null, 'path' => $vp['path'],
        'items' => array_map(fn($r) => ser($r, $u, ['perm' => $r['owner_id'] === $u['id'] ? 'owner' : $perm]), $rows)]);
});
const WRITABLE_OWNERS = "(i.owner_id=:uid OR i.owner_id IN (SELECT team_id FROM team_members WHERE user_id=:uid AND role IN ('manager','member')))";
route('GET', '/api/view/:view', function ($p) {
    $u = me(); $v = $p['view']; $P = ['uid' => $u['id']];
    $ok = fn($rows) => array_values(array_filter($rows, fn($r) => perm($u, $r)));
    if ($v === 'recent') $rows = with_location($u, array_slice($ok(q(list_sql("i.type='file' AND i.trashed_at IS NULL AND (" . WRITABLE_OWNERS . " OR i.modified_by=:uname OR i.owner_id IN (SELECT team_id FROM team_members WHERE user_id=:uid))") . ' ORDER BY i.modified DESC LIMIT 80', $P + ['uname' => $u['name']])), 0, 60));
    elseif ($v === 'starred') $rows = with_location($u, $ok(q(list_sql('i.trashed_at IS NULL AND EXISTS(SELECT 1 FROM stars s WHERE s.item_id=i.id AND s.user_id=:uid)'), $P)));
    elseif ($v === 'shared') $rows = array_map(fn($r) => ser($r, $u, ['location' => 'Partagé par ' . $r['owner_name'], 'perm' => perm($u, $r)]), q(list_sql('i.trashed_at IS NULL AND i.id IN (SELECT item_id FROM access WHERE user_id=:uid)'), $P));
    elseif ($v === 'links') $rows = with_location($u, array_values(array_filter(q(list_sql(WRITABLE_OWNERS . ' AND i.trashed_at IS NULL AND (EXISTS(SELECT 1 FROM links l WHERE l.item_id=i.id) OR EXISTS(SELECT 1 FROM access a WHERE a.item_id=i.id))'), $P), fn($r) => perm($u, $r) === 'owner')));
    elseif ($v === 'trash') $rows = with_location($u, q(list_sql(WRITABLE_OWNERS . ' AND i.trash_root=1 AND i.trashed_at IS NOT NULL'), $P));
    else throw E(404, 'Vue inconnue');
    json_out(['items' => $rows]);
});
route('GET', '/api/search', function () {
    $u = me(); $qs = trim((string) ($_GET['q'] ?? ''));
    if ($qs === '') { json_out(['items' => []]); return; }
    $like = '%' . preg_replace('/[\\\\%_]/', '\\\\$0', $qs) . '%';
    $snips = [];
    if (fts5() && ($m = fts_match($qs))) {
        try { foreach (q("SELECT item_id, snippet(fts, 2, char(1), char(2), '…', 14) AS s FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT 500", [$m]) as $r) $snips[$r['item_id']] = $r['s']; } catch (Throwable $e) { }
    } elseif (!fts5()) {
        foreach (q('SELECT item_id, substr(content, max(1, instr(lower(content), lower(?)) - 60), 160) AS s FROM fts WHERE content LIKE ? LIMIT 300', [$qs, '%' . $qs . '%']) as $r) $snips[$r['item_id']] = '…' . str_ireplace($qs, "\x01" . $qs . "\x02", $r['s']) . '…';
    }
    $ids = array_keys($snips);
    $in = $ids ? ' OR i.id IN (' . implode(',', array_map(fn($k) => ':s' . $k, array_keys($ids))) . ')' : '';
    $params = ['uid' => $u['id'], 'q' => $like]; foreach ($ids as $k => $id) $params['s' . $k] = $id;
    $rows = q(list_sql("i.trashed_at IS NULL AND (i.name LIKE :q ESCAPE '\\' OR i.description LIKE :q ESCAPE '\\'$in)") . ' LIMIT 1500', $params);
    $vis = array_slice(array_values(array_filter($rows, fn($r) => perm($u, $r))), 0, 300);
    $lq = mb_strtolower($qs);
    usort($vis, fn($a, $b) => ((int) str_contains(mb_strtolower($b['name']), $lq) - (int) str_contains(mb_strtolower($a['name']), $lq)) ?: ($b['modified'] <=> $a['modified']));
    json_out(['items' => with_location($u, $vis, function ($r) use ($snips) { $s = $snips[$r['id']] ?? null; return $s && str_contains($s, "\x01") ? ['snippet' => preg_replace('/\s+/u', ' ', $s)] : []; })]);
});

/* ============================== Détails, commentaires ============================== */
route('GET', '/api/items/:id', function ($p) {
    $u = me(); $it = need($u, $p['id']);
    $desc = $it['type'] === 'folder' ? descendants($it['id']) : [];
    $size = $it['type'] === 'folder' ? array_sum(array_map(fn($d) => !$d['trashed_at'] && $d['type'] === 'file' ? $d['size'] : 0, $desc)) : (int) $it['size'];
    $count = $it['type'] === 'folder' ? count(array_filter($desc, fn($d) => !$d['trashed_at'])) - 1 : 0;
    $vp = visible_path($u, $it['id'], false);
    json_out(ser(item_row($u, $it['id']), $u, ['perm' => $it['perm'], 'totalSize' => $size, 'count' => $count, 'location' => implode(' / ', array_merge([root_label($vp)], array_column($vp['path'], 'name')))]));
});
route('GET', '/api/items/:id/activity', function ($p) { $it = need(me(), $p['id']); json_out(q('SELECT user_name, action, detail, at FROM activity WHERE item_id=? ORDER BY at DESC LIMIT 50', [$it['id']])); });
route('GET', '/api/items/:id/comments', function ($p) {
    $u = me(); $it = need($u, $p['id']);
    json_out(array_map(fn($c) => $c + ['mine' => $c['user_id'] === $u['id'], 'canDelete' => $c['user_id'] === $u['id'] || $it['perm'] === 'owner'],
        q('SELECT id, user_id, user_name, text, created FROM comments WHERE item_id=? ORDER BY created', [$it['id']])));
});
route('POST', '/api/items/:id/comments', function ($p) {
    $u = me(); $it = need($u, $p['id']);
    $t = mb_substr(trim((string) input('text', '')), 0, 4000);
    if ($t === '') throw E(400, 'Commentaire vide');
    run('INSERT INTO comments(id,item_id,user_id,user_name,text,created) VALUES(?,?,?,?,?,?)', [uid(), $it['id'], $u['id'], $u['name'], $t, now()]);
    log_act($it['id'], $u, 'comment');
    json_out(['ok' => true]);
});
route('DELETE', '/api/comments/:cid', function ($p) {
    $u = me();
    $c = q1('SELECT * FROM comments WHERE id=?', [$p['cid']]); if (!$c) throw E(404, 'Commentaire introuvable');
    $it = need($u, $c['item_id']);
    if ($c['user_id'] !== $u['id'] && $it['perm'] !== 'owner') throw E(403, 'Droits insuffisants');
    run('DELETE FROM comments WHERE id=?', [$c['id']]);
    json_out(['ok' => true]);
});

/* ============================== Création ============================== */
route('POST', '/api/folders', function () {
    $u = me(); $t = resolve_parent($u, input('parent'));
    $it = create_item(['owner' => $t['owner'], 'parent' => $t['parent'], 'type' => 'folder', 'name' => input('name') ?: 'Nouveau dossier', 'by' => $u['name']]);
    log_act($it['id'], $u, 'create');
    json_out(ser($it, $u));
});
route('POST', '/api/new', function () {
    $u = me(); $kind = (string) input('kind', 'txt'); $t = resolve_parent($u, input('parent'));
    $tpl = ['docx' => 'blank.docx', 'xlsx' => 'blank.xlsx', 'pptx' => 'blank.pptx'];
    if (isset($tpl[$kind])) $buf = (string) file_get_contents(dirname(__DIR__) . '/templates/' . $tpl[$kind]);
    elseif (in_array($kind, ['txt', 'md', 'csv'], true)) $buf = (string) input('content', '');
    else throw E(400, 'Type de document inconnu');
    check_quota($t['owner'], strlen($buf));
    $name = clean_name(input('name') ?: 'Sans titre');
    if (ext($name) !== $kind) $name .= '.' . $kind;
    $it = create_item(['owner' => $t['owner'], 'parent' => $t['parent'], 'type' => 'file', 'name' => $name, 'size' => strlen($buf), 'mime' => mime_of($name), 'by' => $u['name']]);
    file_put_contents(fpath($it['id']), $buf);
    log_act($it['id'], $u, 'create');
    index_later($it['id']);
    json_out(ser($it, $u));
});
route('POST', '/api/upload', function () {
    $u = me();
    try { $t = resolve_parent($u, $_GET['parent'] ?? ($_POST['parent'] ?? 'root')); } catch (Throwable $e) { discard_uploads(); throw $e; }
    $files = collect_uploads('u:' . $u['id']);
    if ($files === null) { json_out(['partial' => true]); return; }
    $items = store_uploads($files, $t['owner'], $t['parent'], $u);
    json_out(['items' => array_map(fn($i) => ser($i, $u), $items)]);
});
route('POST', '/api/items/:id/extract', function ($p) {
    $u = me(); $z = need($u, $p['id']);
    if (!class_exists('ZipArchive')) throw E(501, "L'extension PHP zip n'est pas installée sur ce serveur");
    if ($z['type'] !== 'file' || ext($z['name']) !== 'zip') throw E(400, 'Seules les archives .zip peuvent être extraites');
    $parent = get_item($z['parent_id']);
    $target = $z['parent_id'] && can_edit(perm($u, $parent)) ? ['owner' => $z['owner_id'], 'parent' => $z['parent_id']]
        : (!$z['parent_id'] && can_edit($z['perm']) ? ['owner' => $z['owner_id'], 'parent' => null] : ['owner' => $u['id'], 'parent' => null]);
    $zip = new ZipArchive();
    if ($zip->open(fpath($z['id'])) !== true) throw E(400, 'Archive illisible ou corrompue');
    $entries = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $st = $zip->statIndex($i);
        if (preg_match('#(^|/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(/|$)#i', $st['name'])) continue;
        if (($st['encryption_method'] ?? 0) > 0) throw E(400, 'Les archives protégées par mot de passe ne sont pas prises en charge');
        $entries[] = $st;
    }
    if (count($entries) > 20000) throw E(400, 'Archive trop volumineuse (plus de 20 000 éléments)');
    check_quota($target['owner'], array_sum(array_column($entries, 'size')));
    @set_time_limit(0);
    $root = create_item(['owner' => $target['owner'], 'parent' => $target['parent'], 'type' => 'folder', 'name' => preg_replace('/\.zip$/i', '', $z['name']), 'by' => $u['name']]);
    $folders = ['' => $root['id']];
    $dirOf = function (array $segs) use (&$folders, $root, $target, $u) {
        $key = ''; $p = $root['id'];
        foreach ($segs as $s) { $key .= '/' . $s; if (!isset($folders[$key])) $folders[$key] = create_item(['owner' => $target['owner'], 'parent' => $p, 'type' => 'folder', 'name' => $s, 'by' => $u['name']])['id']; $p = $folders[$key]; }
        return $p;
    };
    $n = 0;
    foreach ($entries as $e) {
        $name = $e['name'];
        if (!mb_check_encoding($name, 'UTF-8')) $name = mb_convert_encoding($name, 'UTF-8', 'CP850');
        $isDir = str_ends_with($name, '/');
        $segs = array_values(array_filter(array_map(fn($s) => trim(preg_replace('/[\\\\\/:*?"<>|\x00-\x1f]/u', '', $s)), explode('/', str_replace('\\', '/', $name))), fn($s) => $s !== '' && $s !== '.' && $s !== '..'));
        if (!$segs) continue;
        if ($isDir) { $dirOf($segs); continue; }
        $fname = array_pop($segs); $par = $dirOf($segs);
        $it = create_item(['owner' => $target['owner'], 'parent' => $par, 'type' => 'file', 'name' => $fname, 'size' => $e['size'], 'mime' => mime_of($fname), 'by' => $u['name']]);
        $in = $zip->getStream($e['name']); $out = fopen(fpath($it['id']), 'wb'); stream_copy_to_stream($in, $out); fclose($in); fclose($out);
        index_later($it['id']);
        $n++;
    }
    $zip->close();
    log_act($root['id'], $u, 'extract', $z['name']);
    json_out(['folder' => ser($root, $u), 'count' => $n]);
});

/* ============================== Modification ============================== */
route('PATCH', '/api/items/:id', function ($p) {
    $u = me(); $b = body();
    $onlyStar = array_key_exists('starred', $b) && count($b) === 1;
    $it = need($u, $p['id'], $onlyStar ? 'view' : 'edit');
    if (isset($b['name'])) {
        $n = clean_name($b['name']);
        foreach (siblings($it['parent_id'], $it['owner_id']) as $s) if ($s['id'] !== $it['id'] && mb_strtolower($s['name']) === mb_strtolower($n)) throw E(409, 'Un élément porte déjà ce nom à cet emplacement');
        run('UPDATE items SET name=?, modified=? WHERE id=?', [$n, now(), $it['id']]);
        index_rename($it['id'], $n);
        log_act($it['id'], $u, 'rename', "{$it['name']} → $n");
    }
    if (array_key_exists('description', $b)) run('UPDATE items SET description=? WHERE id=?', [mb_substr((string) $b['description'], 0, 2000), $it['id']]);
    if (array_key_exists('color', $b)) run('UPDATE items SET color=? WHERE id=?', [in_array($b['color'], COLORS, true) ? $b['color'] : null, $it['id']]);
    if (array_key_exists('starred', $b)) {
        if ($b['starred']) run('INSERT OR IGNORE INTO stars(user_id,item_id) VALUES(?,?)', [$u['id'], $it['id']]);
        else run('DELETE FROM stars WHERE user_id=? AND item_id=?', [$u['id'], $it['id']]);
    }
    json_out(ser(item_row($u, $it['id']), $u));
});
route('PUT', '/api/items/:id/content', function ($p) {
    $u = me(); $it = need($u, $p['id'], 'edit');
    if ($it['type'] !== 'file') throw E(400, 'Pas un fichier');
    $buf = (string) file_get_contents('php://input');
    check_quota($it['owner_id'], strlen($buf));
    $n = save_new_version($it, $buf, $u['name']);
    log_act($it['id'], $u, 'edit');
    json_out(ser($n, $u));
});
route('POST', '/api/move', function () {
    $u = me(); $ids = (array) input('ids', []);
    $target = (string) (input('target') ?: 'root');
    $dest = resolve_parent($u, $target);
    $destName = $dest['parent'] ? get_item($dest['parent'])['name'] : (str_starts_with($target, 'team:') ? get_user($dest['owner'])['name'] : 'Mon espace');
    $n = 0;
    foreach ($ids as $id) {
        $it = need($u, $id, 'edit');
        if ($it['parent_id'] === $dest['parent'] && $it['owner_id'] === $dest['owner']) continue;
        move_item($u, $it, $dest);
        log_act($it['id'], $u, 'move', $destName);
        $n++;
    }
    json_out(['moved' => $n]);
});
route('POST', '/api/copy', function () {
    $u = me(); $b = body(); $out = [];
    foreach ((array) ($b['ids'] ?? []) as $id) {
        $it = need($u, $id);
        if (array_key_exists('target', $b)) $t = resolve_parent($u, $b['target']);
        elseif (can_edit($it['perm'])) $t = ['owner' => $it['owner_id'], 'parent' => $it['parent_id']];
        else $t = ['owner' => $u['id'], 'parent' => null];
        check_quota($t['owner'], array_sum(array_map(fn($d) => $d['trashed_at'] ? 0 : $d['size'], descendants($it['id']))));
        $c = copy_tree($it, $t['parent'], $t['owner'], $u, !array_key_exists('target', $b) && $t['parent'] === $it['parent_id'] && $t['owner'] === $it['owner_id']);
        log_act($c['id'], $u, 'copy', $it['name']);
        $out[] = ser($c, $u);
    }
    json_out(['items' => $out]);
});
route('POST', '/api/trash', function () { $u = me(); foreach ((array) input('ids', []) as $id) { $it = need($u, $id, 'edit'); if (!$it['trashed_at']) { trash_item($it); log_act($it['id'], $u, 'trash'); } } json_out(['ok' => true]); });
route('POST', '/api/restore', function () { $u = me(); foreach ((array) input('ids', []) as $id) { $it = need($u, $id, 'edit'); if ($it['trashed_at']) { restore_item($it); log_act($it['id'], $u, 'restore'); } } json_out(['ok' => true]); });
route('POST', '/api/purge', function () { $u = me(); foreach ((array) input('ids', []) as $id) purge_item(need($u, $id, 'owner')); json_out(['ok' => true]); });
route('POST', '/api/trash/empty', function () {
    $u = me();
    $owners = array_merge([$u['id']], array_column(array_filter(my_teams($u['id']), fn($t) => $t['role'] === 'manager'), 'id'));
    foreach ($owners as $o) foreach (q('SELECT * FROM items WHERE owner_id=? AND trash_root=1', [$o]) as $it) purge_item($it);
    json_out(['ok' => true]);
});

/* ============================== Téléchargement, versions ============================== */
route('GET', '/api/items/:id/raw', function ($p) {
    $u = me(); $it = need($u, $p['id']);
    if ($it['type'] === 'folder') { zip_to_output([$it], $it['name'] . '.zip'); return; }
    if (!empty($_GET['dl'])) log_act($it['id'], $u, 'download');
    send_file(fpath($it['id']), $it['name'], $it['mime'], !empty($_GET['dl']));
});
route('GET', '/api/zip', function () {
    $u = me();
    $items = array_map(fn($id) => need($u, $id), array_filter(explode(',', (string) ($_GET['ids'] ?? ''))));
    if (!$items) throw E(400, 'Aucun élément');
    zip_to_output($items, count($items) === 1 ? $items[0]['name'] . '.zip' : app_name() . ' - ' . date('Y-m-d') . '.zip');
});
route('GET', '/api/items/:id/versions', function ($p) {
    $it = need(me(), $p['id']);
    json_out(['current' => ['version' => (int) $it['version'], 'size' => (int) $it['size'], 'modified' => (int) $it['modified'], 'author' => $it['modified_by']],
        'versions' => q('SELECT id, version, size, created, author FROM versions WHERE item_id=? ORDER BY version DESC', [$it['id']])]);
});
route('GET', '/api/versions/:vid/raw', function ($p) {
    $v = q1('SELECT * FROM versions WHERE id=?', [$p['vid']]); if (!$v) throw E(404, 'Version introuvable');
    $it = need(me(), $v['item_id']);
    $d = strrpos($it['name'], '.');
    send_file(vpath($v['id']), ($d > 0 ? substr($it['name'], 0, $d) : $it['name']) . " (v{$v['version']})" . ($d > 0 ? substr($it['name'], $d) : ''), $it['mime'], true);
});
route('POST', '/api/versions/:vid/restore', function ($p) {
    $u = me();
    $v = q1('SELECT * FROM versions WHERE id=?', [$p['vid']]); if (!$v) throw E(404, 'Version introuvable');
    $it = need($u, $v['item_id'], 'edit');
    save_new_version($it, (string) file_get_contents(vpath($v['id'])), $u['name']);
    log_act($it['id'], $u, 'version', 'Restauration de la version ' . $v['version']);
    json_out(['ok' => true]);
});

/* ============================== Partage ============================== */
route('GET', '/api/items/:id/shares', function ($p) {
    $u = me(); $it = need($u, $p['id']);
    json_out(['perm' => $it['perm'], 'owner' => get_user($it['owner_id'])['name'],
        'access' => q('SELECT a.user_id, a.perm, u.name, u.email FROM access a JOIN users u ON u.id=a.user_id WHERE a.item_id=? ORDER BY u.name', [$it['id']]),
        'links' => $it['perm'] === 'owner' ? array_map(fn($l) => $l + ['protected' => (bool) $l['protected'], 'url' => app_url() . '/s/' . $l['token']],
            q('SELECT token, mode, expires, created, views, (password IS NOT NULL) AS protected FROM links WHERE item_id=? ORDER BY created DESC', [$it['id']])) : []]);
});
route('POST', '/api/items/:id/access', function ($p) {
    $u = me(); $it = need($u, $p['id'], 'owner');
    $t = q1("SELECT * FROM users WHERE email=? AND kind='user'", [trim((string) input('email', ''))]);
    if (!$t) throw E(404, 'Aucun utilisateur avec cette adresse');
    if ($t['id'] === $u['id']) throw E(400, 'Vous êtes déjà propriétaire');
    $perm = input('perm') === 'edit' ? 'edit' : 'view';
    run('INSERT INTO access(item_id,user_id,perm,created) VALUES(?,?,?,?) ON CONFLICT(item_id,user_id) DO UPDATE SET perm=excluded.perm', [$it['id'], $t['id'], $perm, now()]);
    log_act($it['id'], $u, 'share', $t['name'] . ' (' . ($perm === 'edit' ? 'modification' : 'lecture') . ')');
    json_out(['ok' => true]);
});
route('DELETE', '/api/items/:id/access/:uid', function ($p) {
    $u = me(); $it = need($u, $p['id']);
    if ($it['perm'] !== 'owner' && $p['uid'] !== $u['id']) throw E(403, 'Droits insuffisants');
    run('DELETE FROM access WHERE item_id=? AND user_id=?', [$it['id'], $p['uid']]);
    json_out(['ok' => true]);
});
route('GET', '/api/users/lookup', function () {
    $u = me(); $qs = trim((string) ($_GET['q'] ?? ''));
    if (mb_strlen($qs) < 2) { json_out([]); return; }
    json_out(q("SELECT name, email FROM users WHERE disabled=0 AND kind='user' AND id<>? AND (email LIKE ? OR name LIKE ?) LIMIT 8", [$u['id'], "%$qs%", "%$qs%"]));
});
const LINK_MODES = ['view', 'edit', 'upload'];
function end_of_day($d): ?int { return $d ? (strtotime($d . ' 23:59:59') ?: 0) * 1000 : null; }
route('POST', '/api/items/:id/links', function ($p) {
    $u = me(); $it = need($u, $p['id'], 'owner');
    $mode = in_array(input('mode'), LINK_MODES, true) ? input('mode') : 'view';
    if ($mode === 'upload' && $it['type'] !== 'folder') throw E(400, 'Le mode dépôt est réservé aux dossiers');
    $token = rtrim(strtr(base64_encode(random_bytes(12)), '+/', '-_'), '=');
    run('INSERT INTO links(token,item_id,mode,password,expires,created_by,created) VALUES(?,?,?,?,?,?,?)',
        [$token, $it['id'], $mode, input('password') ? password_hash((string) input('password'), PASSWORD_DEFAULT) : null, end_of_day(input('expires')), $u['id'], now()]);
    log_act($it['id'], $u, 'link', $mode);
    json_out(['token' => $token, 'url' => app_url() . '/s/' . $token]);
});
route('PATCH', '/api/links/:token', function ($p) {
    $u = me(); $b = body();
    $l = q1('SELECT * FROM links WHERE token=?', [$p['token']]); if (!$l) throw E(404, 'Lien introuvable');
    $it = need($u, $l['item_id'], 'owner');
    if (!empty($b['mode']) && in_array($b['mode'], LINK_MODES, true)) { if ($b['mode'] === 'upload' && $it['type'] !== 'folder') throw E(400, 'Le mode dépôt est réservé aux dossiers'); run('UPDATE links SET mode=? WHERE token=?', [$b['mode'], $l['token']]); }
    if (array_key_exists('expires', $b)) run('UPDATE links SET expires=? WHERE token=?', [end_of_day($b['expires']), $l['token']]);
    if (array_key_exists('password', $b)) run('UPDATE links SET password=? WHERE token=?', [$b['password'] ? password_hash((string) $b['password'], PASSWORD_DEFAULT) : null, $l['token']]);
    json_out(['ok' => true]);
});
route('DELETE', '/api/links/:token', function ($p) {
    $u = me();
    $l = q1('SELECT * FROM links WHERE token=?', [$p['token']]); if (!$l) throw E(404, 'Lien introuvable');
    need($u, $l['item_id'], 'owner');
    run('DELETE FROM links WHERE token=?', [$l['token']]);
    json_out(['ok' => true]);
});

/* ============================== OnlyOffice (utilisateur connecté) ============================== */
route('GET', '/api/oo/:id', function ($p) {
    if (!oo_url()) throw E(400, "OnlyOffice n'est pas configuré sur ce serveur");
    $u = me(); $it = need($u, $p['id']); $ext = ext($it['name']);
    if ($it['type'] !== 'file' || !doc_type($ext)) throw E(400, "Ce format ne s'ouvre pas dans OnlyOffice");
    $mode = can_edit($it['perm']) && in_array($ext, OO_EDIT, true) && ($_GET['mode'] ?? '') !== 'view' ? 'edit' : 'view';
    $back = $it['parent_id'] && perm($u, get_item($it['parent_id'])) ? app_url() . '/#f-' . $it['parent_id'] : (is_team($it['owner_id']) ? app_url() . '/#t-' . $it['owner_id'] : app_url() . '/');
    log_act($it['id'], $u, 'open', $mode === 'edit' ? 'OnlyOffice (modification)' : 'OnlyOffice (lecture)');
    [$f, $c] = ds_urls($it);
    json_out(['ooUrl' => oo_url(), 'mode' => $mode, 'name' => $it['name'], 'config' => oo_config($it, $u, $mode, $f, $c, $back)]);
});
route('GET', '/oo/file/:id', function ($p) {
    $t = jwt_verify($_GET['t'] ?? '', SECRET);
    if (!$t || ($t['k'] ?? '') !== 'file' || ($t['fid'] ?? '') !== $p['id']) throw E(403, 'Jeton invalide');
    $it = get_item($p['id']); if (!$it) throw E(404, 'Introuvable');
    send_file(fpath($it['id']), $it['name'], $it['mime'], true);
});
route('POST', '/oo/callback/:id', function ($p) {
    $t = jwt_verify($_GET['t'] ?? '', SECRET);
    if (!$t || ($t['k'] ?? '') !== 'cb' || ($t['fid'] ?? '') !== $p['id']) { json_out(['error' => 1]); return; }
    $b = json_decode((string) file_get_contents('php://input'), true) ?: [];
    if (oo_secret()) {
        $tok = $b['token'] ?? preg_replace('/^Bearer\s+/i', '', $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? ''));
        $d = jwt_verify($tok, oo_secret());
        if (!$d) { error_log('[OnlyOffice] jeton de callback invalide'); json_out(['error' => 1]); return; }
        $b = $d['payload'] ?? $d;
    }
    $it = get_item($p['id']);
    if (!$it) { json_out(['error' => 1]); return; }
    if (in_array($b['status'] ?? 0, [2, 6], true) && !empty($b['url'])) {
        $data = http_get((string) $b['url']);
        if ($data === null) { error_log("[OnlyOffice] téléchargement impossible : {$b['url']}"); json_out(['error' => 1]); return; }
        $uidEditor = $b['users'][0] ?? ($b['actions'][0]['userid'] ?? null);
        $editor = $uidEditor ? get_user((string) $uidEditor) : null;
        $author = $editor['name'] ?? 'Invité (lien)';
        save_new_version($it, $data, $author, $b['filetype'] ?? null);
        log_act($it['id'], $editor ?: ['id' => null, 'name' => $author], 'edit', ($b['status'] ?? 0) === 6 ? 'Enregistrement OnlyOffice' : 'Modifié dans OnlyOffice');
    }
    json_out(['error' => 0]);
});
function http_get(string $url): ?string
{
    if (function_exists('curl_init')) {
        $c = curl_init($url);
        curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 120, CURLOPT_CONNECTTIMEOUT => 15]);
        $r = curl_exec($c); $code = curl_getinfo($c, CURLINFO_HTTP_CODE); curl_close($c);
        return $r !== false && $code < 400 ? (string) $r : null;
    }
    $r = @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 120]]));
    return $r === false ? null : $r;
}

/* ============================== Espaces d'équipe ============================== */
function team_out(array $t, bool $withMembers): array
{
    $o = ['id' => $t['id'], 'name' => $t['name'], 'quota' => (int) $t['quota'], 'used' => used($t['id']), 'created' => (int) $t['created'],
        'files' => (int) q1("SELECT COUNT(*) AS c FROM items WHERE owner_id=? AND type='file'", [$t['id']])['c']];
    if ($withMembers) $o['members'] = q('SELECT m.user_id, m.role, u.name, u.email FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.name COLLATE NOCASE', [$t['id']]);
    return $o;
}
function need_team(string $id, bool $manage): array
{
    $u = me(); $t = get_user($id);
    if (!$t || $t['kind'] !== 'team') throw E(404, 'Espace introuvable');
    $role = team_role($t['id'], $u['id']);
    if ($u['role'] !== 'admin' && (!$role || ($manage && $role !== 'manager'))) throw E(403, 'Droits insuffisants');
    return $t;
}
route('GET', '/api/teams/:id', function ($p) { json_out(team_out(need_team($p['id'], false), true)); });
route('POST', '/api/teams/:id/members', function ($p) {
    $t = need_team($p['id'], true);
    $target = q1("SELECT * FROM users WHERE email=? AND kind='user'", [trim((string) input('email', ''))]);
    if (!$target) throw E(404, 'Aucun utilisateur avec cette adresse');
    $role = isset(ROLE_PERM[input('role')]) ? input('role') : 'member';
    run('INSERT INTO team_members(team_id,user_id,role) VALUES(?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role', [$t['id'], $target['id'], $role]);
    json_out(['ok' => true]);
});
route('DELETE', '/api/teams/:id/members/:uid', function ($p) {
    $t = need_team($p['id'], $p['uid'] !== me()['id']);
    run('DELETE FROM team_members WHERE team_id=? AND user_id=?', [$t['id'], $p['uid']]);
    json_out(['ok' => true]);
});

/* ============================== Administration ============================== */
route('GET', '/api/admin/users', function () {
    need_admin();
    $disk = @disk_free_space(DATA); $total = @disk_total_space(DATA);
    json_out([
        'users' => array_map(fn($u) => pub_user($u) + ['used' => used($u['id']), 'files' => (int) q1("SELECT COUNT(*) AS c FROM items WHERE owner_id=? AND type='file'", [$u['id']])['c']],
            q("SELECT * FROM users WHERE kind='user' ORDER BY name COLLATE NOCASE")),
        'settings' => ['allow_signup' => conf('allow_signup') === '1', 'default_quota' => default_quota(), 'configurable' => true,
            'app_name' => app_name(), 'trash_days' => trash_days(), 'max_versions' => max_versions(), 'oo_url' => oo_url(), 'oo_secret_set' => oo_secret() !== '',
            'server' => ['Version' => ED_VERSION . ' (PHP)', 'PHP' => PHP_VERSION, 'SQLite' => (string) q1('SELECT sqlite_version() AS v')['v'],
                'Recherche plein texte' => fts5() ? 'FTS5' : 'simple (FTS5 indisponible)', 'Taille max. par requête' => round(chunk_size() / 1048576, 1) . ' Mo (envoi par morceaux)',
                'Extension zip' => class_exists('ZipArchive') ? 'oui' : 'non', 'Dossier de données' => DATA]],
        'disk' => $disk !== false && $total ? ['free' => (int) $disk, 'total' => (int) $total] : null,
    ]);
});
route('POST', '/api/admin/users', function () {
    need_admin();
    $email = strtolower(trim((string) input('email', ''))); $name = trim((string) input('name', '')); $pw = (string) input('password', '');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw E(400, 'Adresse e-mail invalide');
    if ($name === '') throw E(400, 'Nom obligatoire');
    if (strlen($pw) < 8) throw E(400, 'Mot de passe : 8 caractères minimum');
    if (q1('SELECT 1 AS x FROM users WHERE email=?', [$email])) throw E(409, 'Adresse déjà utilisée');
    run('INSERT INTO users(id,email,name,password,role,quota,created) VALUES(?,?,?,?,?,?,?)',
        [uid(), $email, $name, password_hash($pw, PASSWORD_DEFAULT), input('role') === 'admin' ? 'admin' : 'user', input('quota') !== null ? parse_size(input('quota')) : default_quota(), now()]);
    json_out(['ok' => true]);
});
route('PATCH', '/api/admin/users/:id', function ($p) {
    $me = need_admin(); $u = get_user($p['id']);
    if (!$u || $u['kind'] !== 'user') throw E(404, 'Utilisateur introuvable');
    $b = body();
    if (!empty($b['reset2fa'])) run('UPDATE users SET totp_secret=NULL, totp_pending=NULL, recovery=NULL WHERE id=?', [$u['id']]);
    if (!empty($b['name'])) run('UPDATE users SET name=? WHERE id=?', [trim((string) $b['name']), $u['id']]);
    if (!empty($b['role']) && $u['id'] !== $me['id']) run('UPDATE users SET role=? WHERE id=?', [$b['role'] === 'admin' ? 'admin' : 'user', $u['id']]);
    if (array_key_exists('quota', $b)) run('UPDATE users SET quota=? WHERE id=?', [parse_size($b['quota']), $u['id']]);
    if (array_key_exists('disabled', $b) && $u['id'] !== $me['id']) run('UPDATE users SET disabled=? WHERE id=?', [$b['disabled'] ? 1 : 0, $u['id']]);
    if (!empty($b['password'])) { if (strlen((string) $b['password']) < 8) throw E(400, 'Mot de passe : 8 caractères minimum'); run('UPDATE users SET password=? WHERE id=?', [password_hash((string) $b['password'], PASSWORD_DEFAULT), $u['id']]); }
    json_out(['ok' => true]);
});
route('DELETE', '/api/admin/users/:id', function ($p) {
    $me = need_admin(); $u = get_user($p['id']);
    if (!$u || $u['kind'] !== 'user') throw E(404, 'Utilisateur introuvable');
    if ($u['id'] === $me['id']) throw E(400, 'Vous ne pouvez pas supprimer votre propre compte');
    foreach (q('SELECT * FROM items WHERE owner_id=? AND parent_id IS NULL', [$u['id']]) as $it) purge_item($it);
    run('DELETE FROM users WHERE id=?', [$u['id']]);
    json_out(['ok' => true]);
});
route('PUT', '/api/admin/settings', function () {
    need_admin(); $b = body();
    if (array_key_exists('allow_signup', $b)) set_setting('allow_signup', $b['allow_signup'] ? '1' : '0');
    if (isset($b['app_name'])) set_setting('app_name', mb_substr(trim((string) $b['app_name']), 0, 60) ?: 'Espace Documents');
    if (isset($b['default_quota'])) set_setting('default_quota', (string) parse_size($b['default_quota']));
    if (isset($b['trash_days'])) set_setting('trash_days', (string) max(1, (int) $b['trash_days']));
    if (isset($b['max_versions'])) set_setting('max_versions', (string) max(1, (int) $b['max_versions']));
    if (array_key_exists('oo_url', $b)) {
        $url = rtrim(trim((string) $b['oo_url']), '/');
        if ($url !== '' && !preg_match('#^https?://#', $url)) throw E(400, "L'adresse OnlyOffice doit commencer par http:// ou https://");
        set_setting('oo_url', $url);
    }
    if (array_key_exists('oo_secret', $b)) set_setting('oo_secret', (string) $b['oo_secret']);
    json_out(['ok' => true]);
});
route('GET', '/api/admin/teams', function () { need_admin(); json_out(array_map(fn($t) => team_out($t, true), q("SELECT * FROM users WHERE kind='team' ORDER BY name COLLATE NOCASE"))); });
route('POST', '/api/admin/teams', function () {
    $me = need_admin();
    $name = mb_substr(trim((string) input('name', '')), 0, 80);
    if ($name === '') throw E(400, 'Nom obligatoire');
    if (q1("SELECT 1 AS x FROM users WHERE kind='team' AND name=? COLLATE NOCASE", [$name])) throw E(409, 'Un espace porte déjà ce nom');
    $id = uid();
    run("INSERT INTO users(id,email,name,password,role,quota,disabled,created,kind) VALUES(?,?,?,?,?,?,1,?,'team')", [$id, "team-$id@espace.local", $name, '!', 'user', input('quota') !== null ? parse_size(input('quota')) : 0, now()]);
    if (input('addMe', true) !== false) run('INSERT INTO team_members(team_id,user_id,role) VALUES(?,?,?)', [$id, $me['id'], 'manager']);
    json_out(['id' => $id]);
});
route('PATCH', '/api/admin/teams/:id', function ($p) {
    need_admin(); $t = need_team($p['id'], true); $b = body();
    if (!empty($b['name'])) {
        $n = mb_substr(trim((string) $b['name']), 0, 80);
        if (q1("SELECT 1 AS x FROM users WHERE kind='team' AND name=? COLLATE NOCASE AND id<>?", [$n, $t['id']])) throw E(409, 'Un espace porte déjà ce nom');
        run('UPDATE users SET name=? WHERE id=?', [$n, $t['id']]);
    }
    if (array_key_exists('quota', $b)) run('UPDATE users SET quota=? WHERE id=?', [parse_size($b['quota']), $t['id']]);
    json_out(['ok' => true]);
});
route('DELETE', '/api/admin/teams/:id', function ($p) {
    need_admin(); $t = need_team($p['id'], true);
    foreach (q('SELECT * FROM items WHERE owner_id=? AND parent_id IS NULL', [$t['id']]) as $it) purge_item($it);
    run('DELETE FROM users WHERE id=?', [$t['id']]);
    json_out(['ok' => true]);
});

/* ============================== Liens publics ============================== */
function link_ctx(string $token): array
{
    $l = q1('SELECT * FROM links WHERE token=?', [$token]);
    if (!$l) throw E(404, "Ce lien n'existe pas ou a été supprimé");
    if ($l['expires'] && $l['expires'] < now()) throw E(410, 'Ce lien a expiré');
    $item = get_item($l['item_id']);
    if (!$item || $item['trashed_at']) throw E(404, "L'élément partagé n'est plus disponible");
    if ($l['password']) {
        $c = jwt_verify($_COOKIE['ed_l_' . $l['token']] ?? null, SECRET);
        if (!$c || ($c['t'] ?? '') !== $l['token']) throw E(401, 'Mot de passe requis', ['needPassword' => true]);
    }
    return ['link' => $l, 'item' => $item];
}
function in_link(array $ctx, ?string $id): array
{
    if (!$id || $id === $ctx['item']['id']) return $ctx['item'];
    $it = get_item($id);
    if (!$it || $it['trashed_at'] || !in_array($ctx['item']['id'], array_column(ancestors($it['id']), 'id'), true)) throw E(404, 'Élément introuvable');
    return $it;
}
function guest_name(): string { return mb_substr(trim((string) ($_GET['name'] ?? 'Invité')), 0, 60) ?: 'Invité'; }
function pub_ser(array $it): array { $it['children'] = $it['type'] === 'folder' ? (int) q1('SELECT COUNT(*) AS c FROM items WHERE parent_id=? AND trashed_at IS NULL', [$it['id']])['c'] : 0; return ser($it, null); }
route('GET', '/api/s/:token', function ($p) {
    $ctx = link_ctx($p['token']);
    run('UPDATE links SET views=views+1 WHERE token=?', [$ctx['link']['token']]);
    json_out(['appName' => app_name(), 'mode' => $ctx['link']['mode'], 'owner' => get_user($ctx['item']['owner_id'])['name'], 'item' => pub_ser($ctx['item']), 'onlyoffice' => oo_info(), 'chunkSize' => chunk_size()]);
});
route('POST', '/api/s/:token/unlock', function ($p) {
    $l = q1('SELECT * FROM links WHERE token=?', [$p['token']]); if (!$l) throw E(404, 'Lien introuvable');
    $key = 'link|' . client_ip() . '|' . $l['token']; throttle($key);
    if (!$l['password'] || !password_verify((string) input('password', ''), $l['password'])) { failed($key); throw E(401, 'Mot de passe incorrect'); }
    setcookie('ed_l_' . $l['token'], jwt_sign(['t' => $l['token']], SECRET, 12 * 3600), cookie_opts(12 * 3600));
    json_out(['ok' => true]);
});
route('GET', '/api/s/:token/list', function ($p) {
    $ctx = link_ctx($p['token']);
    if ($ctx['link']['mode'] === 'upload') throw E(403, 'Ce lien permet uniquement le dépôt de fichiers');
    $f = in_link($ctx, $_GET['folder'] ?? null);
    if ($f['type'] !== 'folder') throw E(400, "Ce n'est pas un dossier");
    $anc = ancestors($f['id']); $k = array_search($ctx['item']['id'], array_column($anc, 'id'), true);
    json_out(['folder' => pub_ser($f), 'path' => array_map(fn($a) => ['id' => $a['id'], 'name' => $a['name']], array_slice($anc, (int) $k)),
        'items' => array_map('pub_ser', q('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL', [$f['id']]))]);
});
route('GET', '/api/s/:token/raw/:id', function ($p) {
    $ctx = link_ctx($p['token']);
    if ($ctx['link']['mode'] === 'upload') throw E(403, 'Accès refusé');
    $it = in_link($ctx, $p['id']);
    if ($it['type'] === 'folder') { zip_to_output([$it], $it['name'] . '.zip'); return; }
    send_file(fpath($it['id']), $it['name'], $it['mime'], !empty($_GET['dl']));
});
route('POST', '/api/s/:token/upload', function ($p) {
    try {
        $ctx = link_ctx($p['token']);
        if (!in_array($ctx['link']['mode'], ['upload', 'edit'], true)) throw E(403, "Ce lien ne permet pas l'envoi de fichiers");
        $f = in_link($ctx, $_GET['folder'] ?? null);
        if ($f['type'] !== 'folder') throw E(400, 'Destination invalide');
    } catch (Throwable $e) { discard_uploads(); throw $e; }
    $files = collect_uploads('l:' . $ctx['link']['token'] . '|' . client_ip());
    if ($files === null) { json_out(['partial' => true]); return; }
    $items = store_uploads($files, $f['owner_id'], $f['id'], ['id' => null, 'name' => guest_name() . ' (lien)']);
    json_out(['count' => count($items)]);
});
route('POST', '/api/s/:token/folders', function ($p) {
    $ctx = link_ctx($p['token']);
    if ($ctx['link']['mode'] !== 'edit') throw E(403, 'Droits insuffisants');
    $f = in_link($ctx, (string) input('parent'));
    $it = create_item(['owner' => $f['owner_id'], 'parent' => $f['id'], 'type' => 'folder', 'name' => input('name'), 'by' => guest_name() . ' (lien)']);
    json_out(ser($it, null));
});
route('GET', '/api/s/:token/oo/:id', function ($p) {
    if (!oo_url()) throw E(400, "OnlyOffice n'est pas configuré");
    $ctx = link_ctx($p['token']);
    if ($ctx['link']['mode'] === 'upload') throw E(403, 'Accès refusé');
    $it = in_link($ctx, $p['id']); $ext = ext($it['name']);
    if ($it['type'] !== 'file' || !doc_type($ext)) throw E(400, "Ce format ne s'ouvre pas dans OnlyOffice");
    $mode = $ctx['link']['mode'] === 'edit' && in_array($ext, OO_EDIT, true) ? 'edit' : 'view';
    $name = guest_name();
    $guest = ['id' => 'guest-' . substr(sha1(client_ip() . $name), 0, 10), 'name' => $name . ' (invité)'];
    [$f, $c] = ds_urls($it, $ctx['link']['token']);
    json_out(['ooUrl' => oo_url(), 'mode' => $mode, 'name' => $it['name'], 'config' => oo_config($it, $guest, $mode, $f, $c, app_url() . '/s/' . $ctx['link']['token'])]);
});
