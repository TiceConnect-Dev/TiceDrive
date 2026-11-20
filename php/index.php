<?php
/*
 * Espace Documents — version PHP (sans Composer, sans Docker)
 * Point d'entrée unique : toutes les requêtes passent ici (voir .htaccess).
 */
declare(strict_types=1);

if (PHP_VERSION_ID < 80100) { http_response_code(500); exit('Espace Documents nécessite PHP 8.1 ou plus récent (version actuelle : ' . PHP_VERSION . ').'); }
foreach (['pdo_sqlite', 'mbstring'] as $ext) if (!extension_loaded($ext)) { http_response_code(500); exit("Extension PHP manquante : $ext"); }

require __DIR__ . '/app/bootstrap.php';
require __DIR__ . '/app/core.php';
require __DIR__ . '/app/textindex.php';
require __DIR__ . '/app/totp.php';
require __DIR__ . '/app/api.php';
require __DIR__ . '/app/dav.php';

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$uriPath = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$base = base_path();
$path = substr($uriPath, strlen($base)) ?: '/';
if (str_starts_with($path, '/index.php')) $path = substr($path, 10) ?: '/';
if ($path === '') $path = '/';

header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: same-origin');

/* --- Fichiers statiques (serveur intégré de PHP ou hébergement sans réécriture des assets) --- */
$PUB = __DIR__ . '/public';
if ($method === 'GET' || $method === 'HEAD') {
    $rel = ltrim($path, '/');
    if (preg_match('#^(public/)?((vendor/)?[A-Za-z0-9_.-]+\.(css|js|svg|png|webmanifest))$#', $rel, $m) && is_file("$PUB/{$m[2]}")) {
        $types = ['css' => 'text/css; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'svg' => 'image/svg+xml', 'png' => 'image/png', 'webmanifest' => 'application/manifest+json'];
        $f = "$PUB/{$m[2]}"; $etag = '"' . md5_file($f) . '"';
        header('Content-Type: ' . $types[$m[4]]);
        header('Cache-Control: ' . (in_array($m[4], ['png', 'svg'], true) ? 'public, max-age=86400' : 'no-cache'));
        header('ETag: ' . $etag);
        if ($m[2] === 'sw.js') header('Service-Worker-Allowed: ' . $base . '/');
        if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
        readfile($f);
        exit;
    }
}

/* --- Pages HTML (avec l'adresse de base de l'installation) --- */
function page(string $file): void
{
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    echo str_replace('<base href="/">', '<base href="' . htmlspecialchars(base_path() . '/', ENT_QUOTES) . '">', (string) file_get_contents(__DIR__ . '/public/' . $file));
}

try {
    // WebDAV
    if ($path === '/dav' || str_starts_with($path, '/dav/')) { dav_handle($method, substr($path, 4)); finish(); exit; }
    if ($method === 'OPTIONS' && $path === '/') { dav_headers(); http_response_code(200); exit; }

    // Protection CSRF : les requêtes API modifiantes doivent porter l'en-tête X-ED
    if (str_starts_with($path, '/api/') && !in_array($method, ['GET', 'HEAD', 'OPTIONS'], true) && ($_SERVER['HTTP_X_ED'] ?? '') !== '1') throw E(403, 'Requête refusée');

    if ($method === 'GET' || $method === 'HEAD') {
        if ($path === '/') { if (current_user()) page('app.html'); else { header('Location: ' . $base . '/login'); http_response_code(302); } finish(); exit; }
        if ($path === '/login') { page('login.html'); exit; }
        if (preg_match('#^/edit/[^/]+/?$#', $path)) { if (current_user()) page('editor.html'); else header('Location: ' . $base . '/login', true, 302); exit; }
        if (preg_match('#^/s/[^/]+/?$#', $path)) { page('share.html'); exit; }
        if (preg_match('#^/s/[^/]+/edit/[^/]+/?$#', $path)) { page('editor.html'); exit; }
        if ($path === '/healthz') { json_out(['ok' => true, 'version' => ED_VERSION]); exit; }
    }
    if ($method === 'POST' && $path === '/share-target') { header('Location: ' . $base . '/', true, 303); exit; }

    if (!dispatch($method, $path)) throw E(404, 'Page introuvable');
} catch (HttpError $e) {
    if (!headers_sent()) json_out(['error' => $e->getMessage()] + $e->extra, $e->getCode());
} catch (Throwable $e) {
    error_log('[Espace Documents] ' . $e);
    if (!headers_sent()) json_out(['error' => 'Erreur interne du serveur'], 500);
}
finish();

/* --- Après la réponse : indexation plein texte et maintenance --- */
function finish(): void
{
    static $done = false;
    if ($done) return; $done = true;
    try {
        $pending = !empty($GLOBALS['ED_INDEX_QUEUE']);
        $async = function_exists('fastcgi_finish_request') || function_exists('litespeed_finish_request');
        if ($async) { ignore_user_abort(true); function_exists('fastcgi_finish_request') ? fastcgi_finish_request() : litespeed_finish_request(); }
        ensure_admin_from_config();
        if ($pending || mt_rand(1, 20) === 1) { @set_time_limit(60); index_run($async ? 25.0 : 2.0); }
        if (mt_rand(1, 50) === 1) maintenance();
    } catch (Throwable $e) { error_log('[Espace Documents] tâche de fond : ' . $e->getMessage()); }
}
