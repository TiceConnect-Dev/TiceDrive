<?php
/*
 * Serveur WebDAV (classe 1 + verrous simulés : Windows, macOS, Linux, OnlyOffice mobile…)
 *   /dav/Mon espace/…   /dav/Équipes/<espace>/…   /dav/Partagés avec moi/…
 * Authentification Basic : adresse e-mail + mot de passe d'application
 * (le mot de passe du compte n'est accepté que si la double authentification est désactivée).
 */
declare(strict_types=1);

const DAV_MINE = 'Mon espace';
const DAV_TEAMS = 'Équipes';
const DAV_SHARED = 'Partagés avec moi';

function dav_headers(): void
{
    header('DAV: 1, 2');
    header('MS-Author-Via: DAV');
    header('Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
}
function dav_status(int $code, string $msg = ''): void
{
    http_response_code($code);
    if ($msg !== '') { header('Content-Type: text/plain; charset=utf-8'); echo $msg; }
}
function dav_auth(): ?array
{
    $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    $email = $_SERVER['PHP_AUTH_USER'] ?? null; $pw = $_SERVER['PHP_AUTH_PW'] ?? null;
    if ($email === null && stripos($hdr, 'basic ') === 0) {
        $dec = (string) base64_decode(substr($hdr, 6));
        $i = strpos($dec, ':');
        if ($i === false) return null;
        $email = substr($dec, 0, $i); $pw = substr($dec, $i + 1);
    }
    if ($email === null) return null;
    $email = trim($email);
    $key = 'dav|' . client_ip() . '|' . strtolower($email);
    throttle($key);
    $u = q1("SELECT * FROM users WHERE email=? AND kind='user'", [$email]);
    $ok = $u && !$u['disabled'] && (check_app_password($u, (string) $pw) || (!$u['totp_secret'] && password_verify((string) $pw, $u['password'])));
    if (!$ok) { failed($key); return null; }
    return $u;
}

/* ---------- Résolution des chemins ---------- */
function dav_eq(string $a, string $b): bool { return mb_strtolower($a) === mb_strtolower($b); }
function dav_list(array $d): array
{
    return $d['parent'] ? q('SELECT * FROM items WHERE parent_id=? AND trashed_at IS NULL ORDER BY name COLLATE NOCASE', [$d['parent']])
        : q('SELECT * FROM items WHERE parent_id IS NULL AND owner_id=? AND trashed_at IS NULL ORDER BY name COLLATE NOCASE', [$d['owner']]);
}
function dav_child(array $d, string $name): ?array
{
    foreach (dav_list($d) as $c) if (dav_eq($c['name'], $name)) return $c;
    return null;
}
function dav_shared_roots(array $u): array { return q('SELECT i.* FROM items i JOIN access a ON a.item_id=i.id WHERE a.user_id=? AND i.trashed_at IS NULL ORDER BY i.name COLLATE NOCASE', [$u['id']]); }
function dav_dir_of(array $it, string $p): array { return ['owner' => $it['owner_id'], 'parent' => $it['id'], 'perm' => $p, 'name' => $it['name']]; }
function dav_resolve(array $u, array $segs): ?array
{
    if (!$segs) return ['kind' => 'vroot'];
    $a = array_shift($segs);
    if (dav_eq($a, DAV_MINE)) $d = ['owner' => $u['id'], 'parent' => null, 'perm' => 'owner', 'name' => DAV_MINE];
    elseif (dav_eq($a, DAV_TEAMS)) {
        if (!$segs) return ['kind' => 'vteams'];
        $t = null; foreach (my_teams($u['id']) as $x) if (dav_eq($x['name'], $segs[0])) $t = $x;
        if (!$t) return null;
        array_shift($segs);
        $d = ['owner' => $t['id'], 'parent' => null, 'perm' => ROLE_PERM[$t['role']], 'name' => $t['name']];
    } elseif (dav_eq($a, DAV_SHARED)) {
        if (!$segs) return ['kind' => 'vshared'];
        $it = null; foreach (dav_shared_roots($u) as $x) if (dav_eq($x['name'], $segs[0])) { $it = $x; break; }
        if (!$it) return null;
        array_shift($segs);
        $p = perm($u, $it);
        if (!$segs) return ['kind' => 'item', 'item' => $it, 'perm' => $p, 'dir' => null];
        if ($it['type'] !== 'folder') return null;
        $d = dav_dir_of($it, $p);
    } else return null;
    if (!$segs) return ['kind' => 'dir', 'dir' => $d];
    $n = count($segs);
    foreach ($segs as $i => $name) {
        $last = $i === $n - 1;
        $child = dav_child($d, $name);
        if (!$child) return $last ? ['kind' => 'missing', 'dir' => $d, 'name' => $name] : null;
        $p = $d['perm'] === 'owner' ? 'owner' : (perm($u, $child) ?: $d['perm']);
        if ($last) return ['kind' => 'item', 'item' => $child, 'perm' => $p, 'dir' => $d];
        if ($child['type'] !== 'folder') return null;
        $d = dav_dir_of($child, $p);
    }
    return null;
}

/* ---------- XML ---------- */
function dav_x(string $s): string { return htmlspecialchars($s, ENT_QUOTES | ENT_XML1, 'UTF-8'); }
function dav_href(array $segs, bool $dir): string { return base_path() . '/dav/' . implode('/', array_map('rawurlencode', $segs)) . ($dir && $segs ? '/' : ''); }
function dav_quota(string $owner): array
{
    $u = get_user($owner); $used = used($owner);
    $avail = $u && $u['quota'] > 0 ? max(0, $u['quota'] - $used) : (int) (@disk_free_space(DATA) ?: 1 << 40);
    return ['used' => $used, 'avail' => $avail];
}
function dav_item_props(array $it): array
{
    return ['name' => $it['name'], 'dir' => $it['type'] === 'folder', 'size' => (int) $it['size'], 'mime' => $it['mime'], 'mtime' => (int) $it['modified'], 'ctime' => (int) $it['created'],
        'etag' => $it['type'] === 'folder' ? $it['id'] . '-' . $it['modified'] : $it['id'] . '-' . $it['version'] . '-' . $it['size']];
}
function dav_entry(string $href, array $o): string
{
    $mt = ($o['mtime'] ?? 0) ?: now();
    $x = '<d:response><d:href>' . dav_x($href) . '</d:href><d:propstat><d:prop>'
        . '<d:displayname>' . dav_x($o['name']) . '</d:displayname>'
        . '<d:resourcetype>' . (!empty($o['dir']) ? '<d:collection/>' : '') . '</d:resourcetype>'
        . (!empty($o['dir']) ? '' : '<d:getcontentlength>' . (int) ($o['size'] ?? 0) . '</d:getcontentlength><d:getcontenttype>' . dav_x($o['mime'] ?: 'application/octet-stream') . '</d:getcontenttype>')
        . '<d:getlastmodified>' . gmdate('D, d M Y H:i:s', intdiv($mt, 1000)) . ' GMT</d:getlastmodified>'
        . '<d:creationdate>' . gmdate('Y-m-d\TH:i:s\Z', intdiv(($o['ctime'] ?? 0) ?: $mt, 1000)) . '</d:creationdate>'
        . '<d:getetag>"' . dav_x($o['etag'] ?? 'v') . '"</d:getetag>'
        . (isset($o['quota']) ? '<d:quota-used-bytes>' . $o['quota']['used'] . '</d:quota-used-bytes><d:quota-available-bytes>' . $o['quota']['avail'] . '</d:quota-available-bytes>' : '')
        . '<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>'
        . '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    return $x;
}
function dav_multistatus(array $parts): void
{
    http_response_code(207);
    header('Content-Type: application/xml; charset=utf-8');
    echo '<?xml version="1.0" encoding="utf-8"?>' . "\n" . '<d:multistatus xmlns:d="DAV:">' . implode('', $parts) . '</d:multistatus>';
}

/* ---------- Méthodes ---------- */
function dav_handle(string $method, string $rawPath): void
{
    dav_headers();
    if ($method === 'OPTIONS') { http_response_code(200); header('Content-Length: 0'); return; }
    try { $u = dav_auth(); } catch (HttpError $e) { dav_status(429); return; }
    if (!$u) { header('WWW-Authenticate: Basic realm="' . app_name() . '", charset="UTF-8"'); dav_status(401); return; }
    $segs = array_values(array_filter(array_map('rawurldecode', explode('/', $rawPath)), 'strlen'));
    $r = dav_resolve($u, $segs);
    try {
        switch ($method) {
            case 'PROPFIND': if (!$r || $r['kind'] === 'missing') { dav_status(404); return; } dav_propfind($u, $segs, $r); return;
            case 'GET': case 'HEAD':
                if (!$r || $r['kind'] === 'missing') { dav_status(404); return; }
                if ($r['kind'] === 'item' && $r['item']['type'] === 'file') { send_file(fpath($r['item']['id']), $r['item']['name'], $r['item']['mime'], false); return; }
                header('Content-Type: text/html; charset=utf-8');
                echo '<!doctype html><meta charset="utf-8"><title>' . dav_x(app_name()) . ' — WebDAV</title><p>Dossier WebDAV. Ouvrez cette adresse dans l\'explorateur de fichiers ou un client WebDAV.</p>';
                return;
            case 'PUT': if (!$r) { dav_status(409); return; } dav_put($u, $r); return;
            case 'MKCOL':
                if (!$r) { dav_status(409); return; }
                if ($r['kind'] !== 'missing') { dav_status(405); return; }
                if (!can_edit($r['dir']['perm'])) { dav_status(403); return; }
                create_item(['owner' => $r['dir']['owner'], 'parent' => $r['dir']['parent'], 'type' => 'folder', 'name' => clean_name($r['name']), 'by' => $u['name']]);
                dav_status(201); return;
            case 'DELETE':
                if (!$r || $r['kind'] === 'missing') { dav_status(404); return; }
                if ($r['kind'] !== 'item') { dav_status(403); return; }
                if (!$r['dir']) { run('DELETE FROM access WHERE item_id=? AND user_id=?', [$r['item']['id'], $u['id']]); dav_status(204); return; }
                if (!can_edit($r['perm'])) { dav_status(403); return; }
                trash_item($r['item']); log_act($r['item']['id'], $u, 'trash', 'WebDAV');
                dav_status(204); return;
            case 'MOVE': case 'COPY': if (!$r || $r['kind'] === 'missing') { dav_status(404); return; } dav_move_copy($u, $r, $method === 'MOVE'); return;
            case 'LOCK': if (!$r) { dav_status(409); return; } dav_lock($u, $segs, $r); return;
            case 'UNLOCK': dav_status(204); return;
            case 'PROPPATCH': if (!$r || $r['kind'] === 'missing') { dav_status(404); return; } dav_proppatch($segs, $r); return;
            default: dav_status(405);
        }
    } catch (HttpError $e) {
        dav_status($e->getCode() === 413 ? 507 : $e->getCode(), $e->getMessage());
    }
}
function dav_propfind(array $u, array $segs, array $r): void
{
    $depth = ($_SERVER['HTTP_DEPTH'] ?? '1') === '0' ? 0 : 1;
    $parts = [];
    $self = dav_href($segs, $r['kind'] !== 'item' || $r['item']['type'] === 'folder');
    switch ($r['kind']) {
        case 'vroot':
            $parts[] = dav_entry($self, ['name' => app_name(), 'dir' => true, 'etag' => 'root', 'quota' => dav_quota($u['id'])]);
            if ($depth) {
                $parts[] = dav_entry(dav_href([DAV_MINE], true), ['name' => DAV_MINE, 'dir' => true, 'etag' => 'mine', 'quota' => dav_quota($u['id'])]);
                if (my_teams($u['id'])) $parts[] = dav_entry(dav_href([DAV_TEAMS], true), ['name' => DAV_TEAMS, 'dir' => true, 'etag' => 'teams']);
                if (dav_shared_roots($u)) $parts[] = dav_entry(dav_href([DAV_SHARED], true), ['name' => DAV_SHARED, 'dir' => true, 'etag' => 'shared']);
            }
            break;
        case 'vteams':
            $parts[] = dav_entry($self, ['name' => DAV_TEAMS, 'dir' => true, 'etag' => 'teams']);
            if ($depth) foreach (my_teams($u['id']) as $t) $parts[] = dav_entry(dav_href([DAV_TEAMS, $t['name']], true), ['name' => $t['name'], 'dir' => true, 'etag' => 't' . $t['id'], 'quota' => dav_quota($t['id'])]);
            break;
        case 'vshared':
            $parts[] = dav_entry($self, ['name' => DAV_SHARED, 'dir' => true, 'etag' => 'shared']);
            if ($depth) foreach (dav_shared_roots($u) as $it) $parts[] = dav_entry(dav_href([DAV_SHARED, $it['name']], $it['type'] === 'folder'), dav_item_props($it));
            break;
        case 'dir':
            $parts[] = dav_entry($self, ['name' => $r['dir']['name'], 'dir' => true, 'etag' => 'd' . $r['dir']['owner'], 'quota' => dav_quota($r['dir']['owner'])]);
            if ($depth) foreach (dav_list($r['dir']) as $it) $parts[] = dav_entry(dav_href(array_merge($segs, [$it['name']]), $it['type'] === 'folder'), dav_item_props($it));
            break;
        case 'item':
            $parts[] = dav_entry($self, dav_item_props($r['item']));
            if ($depth && $r['item']['type'] === 'folder') foreach (dav_list(dav_dir_of($r['item'], $r['perm'])) as $it) $parts[] = dav_entry(dav_href(array_merge($segs, [$it['name']]), $it['type'] === 'folder'), dav_item_props($it));
            break;
    }
    dav_multistatus($parts);
}
function dav_put(array $u, array $r): void
{
    if ($r['kind'] === 'item' && $r['item']['type'] === 'folder') { dav_status(405); return; }
    if ($r['kind'] !== 'item' && $r['kind'] !== 'missing') { dav_status(409); return; }
    if (!can_edit($r['kind'] === 'missing' ? $r['dir']['perm'] : $r['perm'])) { dav_status(403); return; }
    $owner = $r['kind'] === 'missing' ? $r['dir']['owner'] : $r['item']['owner_id'];
    $tmp = DATA . '/tmp/dav-' . uid();
    @set_time_limit(0);
    $in = fopen('php://input', 'rb'); $out = fopen($tmp, 'wb'); stream_copy_to_stream($in, $out); fclose($in); fclose($out);
    $size = filesize($tmp);
    try { check_quota($owner, $size); } catch (HttpError $e) { @unlink($tmp); dav_status(507); return; }
    if ($r['kind'] === 'missing') {
        $name = clean_name($r['name']);
        $it = create_item(['owner' => $owner, 'parent' => $r['dir']['parent'], 'type' => 'file', 'name' => $name, 'size' => $size, 'mime' => mime_of($name), 'by' => $u['name']]);
        move_file($tmp, fpath($it['id']));
        index_later($it['id']);
        if ($size > 0) log_act($it['id'], $u, 'upload', 'WebDAV');
        dav_status(201); return;
    }
    $wasEmpty = (int) $r['item']['size'] === 0;
    save_new_version($r['item'], ['path' => $tmp], $u['name']);
    log_act($r['item']['id'], $u, $wasEmpty ? 'upload' : 'edit', 'WebDAV');
    dav_status(204);
}
function dav_move_copy(array $u, array $r, bool $isMove): void
{
    if ($r['kind'] !== 'item') { dav_status(403); return; }
    if ($isMove && (!can_edit($r['perm']) || !$r['dir'])) { dav_status(403); return; }
    $dpath = (string) parse_url($_SERVER['HTTP_DESTINATION'] ?? '', PHP_URL_PATH);
    $k = strpos($dpath, '/dav/');
    if ($k === false) { dav_status(502); return; }
    $dsegs = array_values(array_filter(array_map('rawurldecode', explode('/', substr($dpath, $k + 5))), 'strlen'));
    $dst = dav_resolve($u, $dsegs);
    if (!$dst || !$dsegs) { dav_status(409); return; }
    $overwrite = strtoupper($_SERVER['HTTP_OVERWRITE'] ?? 'T') !== 'F';
    $name = end($dsegs); $created = true;
    if ($dst['kind'] === 'missing') $dir = $dst['dir'];
    elseif ($dst['kind'] === 'item') {
        if (!$dst['dir']) { dav_status(403); return; }
        $dir = $dst['dir'];
        if ($dst['item']['id'] !== $r['item']['id']) {
            if (!$overwrite) { dav_status(412); return; }
            if (!can_edit($dst['perm'])) { dav_status(403); return; }
            trash_item($dst['item']); $created = false;
        }
    } else { dav_status(403); return; }
    if (!can_edit($dir['perm'])) { dav_status(403); return; }
    if ($isMove) { move_item($u, $r['item'], ['owner' => $dir['owner'], 'parent' => $dir['parent']], $name); log_act($r['item']['id'], $u, 'move', 'WebDAV'); }
    else {
        check_quota($dir['owner'], array_sum(array_map(fn($d) => $d['trashed_at'] ? 0 : $d['size'], descendants($r['item']['id']))));
        $c = copy_tree($r['item'], $dir['parent'], $dir['owner'], $u, false, clean_name($name));
        log_act($c['id'], $u, 'copy', 'WebDAV');
    }
    dav_status($created ? 201 : 204);
}
function dav_lock(array $u, array $segs, array $r): void
{
    $body = (string) file_get_contents('php://input');
    $status = 200;
    if ($r['kind'] === 'missing') {
        if (!can_edit($r['dir']['perm'])) { dav_status(403); return; }
        $name = clean_name($r['name']);
        $it = create_item(['owner' => $r['dir']['owner'], 'parent' => $r['dir']['parent'], 'type' => 'file', 'name' => $name, 'size' => 0, 'mime' => mime_of($name), 'by' => $u['name']]);
        file_put_contents(fpath($it['id']), '');
        index_later($it['id']);
        $status = 201;
    }
    $token = preg_match('/<(opaquelocktoken:[^>]+)>/', $_SERVER['HTTP_IF'] ?? '', $m) ? $m[1] : 'opaquelocktoken:' . vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex(random_bytes(16)), 4));
    $owner = preg_match('/<(?:\w+:)?owner[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/', $body, $om) ? trim(strip_tags($om[1])) : '';
    http_response_code($status);
    header('Content-Type: application/xml; charset=utf-8');
    header("Lock-Token: <$token>");
    echo '<?xml version="1.0" encoding="utf-8"?>' . "\n" . '<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth>'
        . ($owner !== '' ? '<d:owner>' . dav_x($owner) . '</d:owner>' : '') . '<d:timeout>Second-3600</d:timeout><d:locktoken><d:href>' . $token . '</d:href></d:locktoken><d:lockroot><d:href>' . dav_x(dav_href($segs, false)) . '</d:href></d:lockroot></d:activelock></d:lockdiscovery></d:prop>';
}
function dav_proppatch(array $segs, array $r): void
{
    $body = (string) file_get_contents('php://input');
    $ns = [];
    if (preg_match_all('/xmlns:(\w+)="([^"]*)"/', $body, $m, PREG_SET_ORDER)) foreach ($m as $x) $ns[$x[1]] = $x[2];
    $props = [];
    if (preg_match_all('/<(?:\w+:)?prop>([\s\S]*?)<\/(?:\w+:)?prop>/', $body, $blocks)) foreach ($blocks[1] as $b)
        if (preg_match_all('/<(?:(\w+):)?([A-Za-z0-9_-]+)[\s>\/]/', $b, $pm, PREG_SET_ORDER)) foreach ($pm as $p) $props[($ns[$p[1]] ?? 'DAV:') . '|' . $p[2]] = [$ns[$p[1]] ?? 'DAV:', $p[2]];
    $out = ''; $i = 0;
    foreach ($props as [$uri, $n]) { $out .= "<x$i:$n xmlns:x$i=\"" . dav_x($uri) . '"/>'; $i++; }
    dav_multistatus(['<d:response><d:href>' . dav_x(dav_href($segs, $r['kind'] !== 'item' || $r['item']['type'] === 'folder')) . '</d:href><d:propstat><d:prop>' . $out . '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>']);
}
