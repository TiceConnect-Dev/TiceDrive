<?php
/*
 * Espace Documents — version PHP
 * Amorçage : configuration, base SQLite, utilitaires HTTP, JWT.
 */
declare(strict_types=1);

const ED_VERSION = '3.0.0';
const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'];
const ROLE_PERM = ['manager' => 'owner', 'member' => 'edit', 'reader' => 'view'];

/* ============================== Configuration ============================== */
$ROOT = dirname(__DIR__);
$CFG = [
    'data_dir' => $ROOT . '/data',
    'app_url' => '',            // détectée automatiquement si vide
    'app_name' => 'Espace Documents',
    'default_quota' => '10G',
    'max_versions' => 20,
    'trash_days' => 30,
    'allow_signup' => false,
    'onlyoffice_url' => '',
    'onlyoffice_jwt_secret' => '',
    'onlyoffice_internal_url' => '', // adresse par laquelle OnlyOffice joint le drive (facultatif)
    'admin_email' => '',
    'admin_password' => '',
];
if (is_file($ROOT . '/config.php')) {
    $user = require $ROOT . '/config.php';
    if (is_array($user)) $CFG = array_merge($CFG, $user);
}
define('DATA', rtrim($CFG['data_dir'], '/\\'));
foreach (['', '/files', '/versions', '/tmp'] as $d) if (!is_dir(DATA . $d)) @mkdir(DATA . $d, 0770, true);
if (!is_writable(DATA)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit("Le dossier de données « " . DATA . " » n'est pas accessible en écriture par PHP.\nDonnez-lui les droits d'écriture (ex. chmod 770) puis rechargez la page.");
}
// Protection du dossier de données s'il est dans l'arborescence web
if (!is_file(DATA . '/.htaccess')) @file_put_contents(DATA . '/.htaccess', "Require all denied\nDeny from all\n");
if (!is_file(DATA . '/index.html')) @file_put_contents(DATA . '/index.html', '');

// Secret de signature (sessions, jetons) généré au premier lancement
$secretFile = DATA . '/secret.php';
if (!is_file($secretFile)) file_put_contents($secretFile, "<?php return '" . bin2hex(random_bytes(48)) . "';\n", LOCK_EX);
define('SECRET', (string) require $secretFile);

/* ============================== Chemins / URL ============================== */
function base_path(): string
{
    static $b = null;
    if ($b === null) {
        $sn = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '/index.php');
        $b = str_ends_with($sn, '/index.php') ? rtrim(dirname($sn), '/') : '';
    }
    return $b; // '' ou '/drive'
}
function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' || ($_SERVER['SERVER_PORT'] ?? '') == 443;
}
function app_url(): string
{
    global $CFG;
    if ($CFG['app_url']) return rtrim($CFG['app_url'], '/');
    $host = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? $_SERVER['HTTP_HOST'] ?? 'localhost';
    return (is_https() ? 'https' : 'http') . '://' . $host . base_path();
}
function ds_base(): string
{
    $i = setting('oo_internal_url', '');
    return $i ? rtrim($i, '/') : app_url();
}

/* ============================== Base de données ============================== */
function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $pdo = new PDO('sqlite:' . DATA . '/drive.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 8000;');
    schema($pdo);
    return $pdo;
}
function schema(PDO $pdo): void
{
    $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL, password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', quota INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_login INTEGER,
  kind TEXT NOT NULL DEFAULT 'user', totp_secret TEXT, totp_pending TEXT, recovery TEXT);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  type TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, mime TEXT, version INTEGER NOT NULL DEFAULT 1, description TEXT,
  trashed_at INTEGER, trash_root INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, modified INTEGER NOT NULL, modified_by TEXT, color TEXT, indexed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id);
CREATE TABLE IF NOT EXISTS stars(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, PRIMARY KEY(user_id, item_id));
CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, version INTEGER NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, author TEXT);
CREATE TABLE IF NOT EXISTS access(item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, perm TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(item_id, user_id));
CREATE TABLE IF NOT EXISTS links(token TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, mode TEXT NOT NULL, password TEXT, expires INTEGER, created_by TEXT NOT NULL, created INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, user_id TEXT, user_name TEXT, action TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_act_item ON activity(item_id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS team_members(team_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, PRIMARY KEY(team_id, user_id));
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, user_id TEXT, user_name TEXT, text TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);
CREATE TABLE IF NOT EXISTS app_passwords(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0);
SQL);
    // Recherche plein texte (FTS5 si disponible, sinon table simple)
    try {
        $pdo->exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(item_id UNINDEXED, name, content, tokenize='unicode61 remove_diacritics 2')");
    } catch (Throwable $e) {
        $pdo->exec('CREATE TABLE IF NOT EXISTS fts(item_id TEXT, name TEXT, content TEXT)');
    }
}
function fts5(): bool
{
    static $v = null;
    if ($v === null) $v = (bool) q1("SELECT 1 AS x FROM sqlite_master WHERE name='fts' AND sql LIKE '%fts5%'");
    return $v;
}
function q(string $sql, array $p = []): array { $s = db()->prepare($sql); $s->execute($p); return $s->fetchAll(); }
function q1(string $sql, array $p = []): ?array { $s = db()->prepare($sql); $s->execute($p); $r = $s->fetch(); return $r === false ? null : $r; }
function run(string $sql, array $p = []): int { $s = db()->prepare($sql); $s->execute($p); return $s->rowCount(); }
function tx(callable $f) { db()->beginTransaction(); try { $r = $f(); db()->commit(); return $r; } catch (Throwable $e) { db()->rollBack(); throw $e; } }

function setting(string $k, $default = null)
{
    static $cache = [];
    if (!array_key_exists($k, $cache)) { $r = q1('SELECT value FROM settings WHERE key=?', [$k]); $cache[$k] = $r ? $r['value'] : null; }
    return $cache[$k] ?? $default;
}
function set_setting(string $k, $v): void { run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [$k, (string) $v]); }

/* --- Paramètres effectifs (base > config.php) --- */
function conf(string $k)
{
    global $CFG;
    $map = ['app_name' => 'app_name', 'default_quota' => 'default_quota', 'max_versions' => 'max_versions', 'trash_days' => 'trash_days',
        'oo_url' => 'onlyoffice_url', 'oo_secret' => 'onlyoffice_jwt_secret', 'oo_internal_url' => 'onlyoffice_internal_url', 'allow_signup' => 'allow_signup'];
    $v = setting($k);
    if ($v !== null) return $v;
    $c = $CFG[$map[$k] ?? $k] ?? null;
    if ($k === 'allow_signup') return $c ? '1' : '0';
    return $c;
}
function app_name(): string { return (string) (conf('app_name') ?: 'Espace Documents'); }
function oo_url(): string { return rtrim((string) conf('oo_url'), '/'); }
function oo_secret(): string { return (string) conf('oo_secret'); }
function default_quota(): int { return parse_size((string) conf('default_quota')); }
function max_versions(): int { return max(1, (int) conf('max_versions')); }
function trash_days(): int { return max(1, (int) conf('trash_days')); }

/* ============================== Utilitaires ============================== */
function now(): int { return (int) round(microtime(true) * 1000); }
function uid(): string { return bin2hex(random_bytes(16)); }
function ext(string $n): string { $i = strrpos($n, '.'); return $i > 0 ? strtolower(substr($n, $i + 1)) : ''; }
function parse_size($s): int
{
    $s = trim((string) $s);
    if (!preg_match('/^(\d+(?:[.,]\d+)?)\s*([KMGT]?)[oB]?$/i', $s, $m)) return (int) $s;
    return (int) round((float) str_replace(',', '.', $m[1]) * (1024 ** strpos(' KMGT', strtoupper($m[2] ?: ' '))));
}
function ini_bytes(string $v): int
{
    $v = trim($v); if ($v === '' || $v === '-1') return PHP_INT_MAX;
    $n = (float) $v; $u = strtolower(substr($v, -1));
    return (int) ($n * ($u === 'g' ? 1 << 30 : ($u === 'm' ? 1 << 20 : ($u === 'k' ? 1 << 10 : 1))));
}
// Taille des morceaux d'envoi selon les limites PHP du serveur
function chunk_size(): int
{
    $lim = min(ini_bytes((string) ini_get('upload_max_filesize')), ini_bytes((string) ini_get('post_max_size')));
    return (int) max(256 * 1024, min(16 << 20, $lim - 128 * 1024));
}

class HttpError extends Exception
{
    public array $extra;
    public function __construct(int $status, string $msg, array $extra = []) { parent::__construct($msg, $status); $this->extra = $extra; }
}
function E(int $status, string $msg, array $extra = []): HttpError { return new HttpError($status, $msg, $extra); }

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}
function body(): array
{
    static $b = null;
    if ($b !== null) return $b;
    $ct = $_SERVER['CONTENT_TYPE'] ?? '';
    if (stripos($ct, 'application/json') !== false) { $b = json_decode((string) file_get_contents('php://input'), true) ?: []; }
    else $b = $_POST ?: [];
    return $b;
}
function input(string $k, $d = null) { $b = body(); return array_key_exists($k, $b) ? $b[$k] : $d; }
function client_ip(): string { return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'; }

/* ============================== JWT (HS256) ============================== */
function b64u(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64u_dec(string $s): string { return (string) base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4)); }
function jwt_sign(array $payload, string $secret, ?int $ttl = null): string
{
    if ($ttl) $payload['exp'] = time() + $ttl;
    if (!isset($payload['iat'])) $payload['iat'] = time();
    $h = b64u(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $p = b64u(json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    return "$h.$p." . b64u(hash_hmac('sha256', "$h.$p", $secret, true));
}
function jwt_verify(?string $tok, string $secret): ?array
{
    if (!$tok || substr_count($tok, '.') !== 2) return null;
    [$h, $p, $s] = explode('.', $tok);
    if (!hash_equals(b64u(hash_hmac('sha256', "$h.$p", $secret, true)), $s)) return null;
    $d = json_decode(b64u_dec($p), true);
    if (!is_array($d) || (isset($d['exp']) && $d['exp'] < time())) return null;
    return $d;
}

/* ============================== Anti force brute ============================== */
function throttle(string $key): void
{
    $a = q1('SELECT * FROM attempts WHERE key=?', [$key]);
    if ($a && $a['until'] > now()) throw E(429, 'Trop de tentatives, réessayez dans quelques minutes');
}
function failed(string $key): void
{
    $a = q1('SELECT * FROM attempts WHERE key=?', [$key]);
    $n = ($a['n'] ?? 0) + 1;
    $until = 0;
    if ($n >= 8) { $until = now() + 600000; $n = 0; }
    run('INSERT INTO attempts(key,n,until,at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET n=excluded.n, until=excluded.until, at=excluded.at', [$key, $n, $until, now()]);
}
function attempts_clear(string $key): void { run('DELETE FROM attempts WHERE key=?', [$key]); }

/* ============================== Types MIME ============================== */
function mime_of(string $name): string
{
    static $m = [
        'txt' => 'text/plain', 'md' => 'text/markdown', 'csv' => 'text/csv', 'html' => 'text/html', 'htm' => 'text/html', 'css' => 'text/css', 'js' => 'text/javascript',
        'json' => 'application/json', 'xml' => 'application/xml', 'pdf' => 'application/pdf', 'zip' => 'application/zip', 'rar' => 'application/vnd.rar', '7z' => 'application/x-7z-compressed',
        'gz' => 'application/gzip', 'tar' => 'application/x-tar', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp',
        'svg' => 'image/svg+xml', 'bmp' => 'image/bmp', 'ico' => 'image/x-icon', 'heic' => 'image/heic', 'avif' => 'image/avif', 'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'ogg' => 'audio/ogg',
        'm4a' => 'audio/mp4', 'flac' => 'audio/flac', 'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mov' => 'video/quicktime', 'mkv' => 'video/x-matroska', 'avi' => 'video/x-msvideo',
        'doc' => 'application/msword', 'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls' => 'application/vnd.ms-excel', 'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt' => 'application/vnd.ms-powerpoint', 'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'odt' => 'application/vnd.oasis.opendocument.text', 'ods' => 'application/vnd.oasis.opendocument.spreadsheet', 'odp' => 'application/vnd.oasis.opendocument.presentation',
        'rtf' => 'application/rtf', 'exe' => 'application/vnd.microsoft.portable-executable', 'msi' => 'application/x-msi', 'iso' => 'application/x-iso9660-image', 'php' => 'text/plain',
        'py' => 'text/x-python', 'sh' => 'text/x-shellscript', 'sql' => 'application/sql', 'log' => 'text/plain', 'ini' => 'text/plain', 'yml' => 'text/yaml', 'yaml' => 'text/yaml',
    ];
    return $m[ext($name)] ?? 'application/octet-stream';
}
