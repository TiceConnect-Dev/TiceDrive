<?php
/*
 * Recherche plein texte : extraction du texte (texte brut, Office, OpenDocument, PDF)
 * et indexation en fin de requête (après l'envoi de la réponse quand PHP-FPM le permet).
 */
declare(strict_types=1);

const TEXT_EXT = ['txt', 'md', 'csv', 'tsv', 'json', 'js', 'ts', 'html', 'htm', 'css', 'php', 'lua', 'py', 'xml', 'yml', 'yaml', 'sql', 'log', 'ini', 'cfg', 'conf', 'sh', 'bat', 'ps1', 'rtf', 'tex', 'srt', 'vtt'];
const MAX_CHARS = 1000000;

$GLOBALS['ED_INDEX_QUEUE'] = [];
function index_later(string $id): void
{
    run('UPDATE items SET indexed=0 WHERE id=?', [$id]);
    $GLOBALS['ED_INDEX_QUEUE'][$id] = true;
}
function index_remove(string $id): void { run('DELETE FROM fts WHERE item_id=?', [$id]); }
function index_rename(string $id, string $name): void { run('UPDATE fts SET name=? WHERE item_id=?', [$name, $id]); }

/** Traite la file d'attente puis l'arriéré, dans une limite de temps. */
function index_run(float $budget): void
{
    $t0 = microtime(true);
    $ids = array_keys($GLOBALS['ED_INDEX_QUEUE']);
    $GLOBALS['ED_INDEX_QUEUE'] = [];
    $more = array_column(q("SELECT id FROM items WHERE type='file' AND indexed=0 LIMIT 50"), 'id');
    foreach (array_unique(array_merge($ids, $more)) as $id) {
        if (microtime(true) - $t0 > $budget) break;
        index_one($id);
    }
}
function index_one(string $id): void
{
    $it = q1('SELECT id,name,type FROM items WHERE id=?', [$id]);
    if (!$it || $it['type'] !== 'file') { index_remove($id); return; }
    $text = '';
    try { if (is_file(fpath($id))) $text = mb_substr(extract_text(fpath($id), ext($it['name'])), 0, MAX_CHARS); } catch (Throwable $e) { $text = ''; }
    if (!mb_check_encoding($text, 'UTF-8')) $text = mb_convert_encoding($text, 'UTF-8', 'Windows-1252');
    tx(function () use ($id, $it, $text) {
        run('DELETE FROM fts WHERE item_id=?', [$id]);
        run('INSERT INTO fts(item_id,name,content) VALUES(?,?,?)', [$id, $it['name'], $text]);
        run('UPDATE items SET indexed=1 WHERE id=?', [$id]);
    });
}

function strip_xml(string $s): string
{
    $s = preg_replace('/<(w:tab|w:br|text:tab|text:line-break|a:br)\b[^>]*\/>/', ' ', $s);
    $s = preg_replace('/<\/(w:p|a:p|text:p|text:h|si|row|table:table-row|c)>/', "\n", $s);
    $s = html_entity_decode(strip_tags($s), ENT_QUOTES | ENT_XML1, 'UTF-8');
    return preg_replace(["/[ \t]+/", "/\n\s*\n+/"], [' ', "\n"], $s);
}
function extract_text(string $file, string $ext): string
{
    $size = filesize($file);
    if (in_array($ext, TEXT_EXT, true)) {
        if ($size > 10 << 20) return '';
        $t = (string) file_get_contents($file);
        if (in_array($ext, ['html', 'htm', 'xml'], true)) $t = strip_xml($t);
        if ($ext === 'rtf') $t = preg_replace('/\\\\[a-z]+-?\d* ?|[{}]/', ' ', $t);
        return $t;
    }
    if ($size > 80 << 20) return '';
    if (in_array($ext, ['docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'xltx', 'pptx', 'pptm', 'potx', 'ppsx', 'odt', 'ods', 'odp', 'ott'], true)) {
        if (!class_exists('ZipArchive')) return '';
        $z = new ZipArchive();
        if ($z->open($file) !== true) return '';
        if (str_starts_with($ext, 'do')) $re = '/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/';
        elseif (str_starts_with($ext, 'xl')) $re = '/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/';
        elseif (str_starts_with($ext, 'p')) $re = '/^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/';
        else $re = '/^content\.xml$/';
        $names = [];
        for ($i = 0; $i < $z->numFiles; $i++) { $n = $z->getNameIndex($i); if (preg_match($re, $n)) $names[] = $n; }
        natsort($names);
        $out = '';
        foreach ($names as $n) $out .= strip_xml((string) $z->getFromName($n)) . "\n";
        $z->close();
        return $out;
    }
    if ($ext === 'pdf') return pdf_text((string) file_get_contents($file));
    return '';
}

/* ---------- Extraction de texte PDF (sans bibliothèque externe) ---------- */
function pdf_streams(string $pdf): array
{
    $out = [];
    if (!preg_match_all('/obj\s*<<(.*?)>>\s*stream\r?\n/s', $pdf, $m, PREG_OFFSET_CAPTURE)) return $out;
    foreach ($m[0] as $i => $hit) {
        $dict = $m[1][$i][0];
        $start = $hit[1] + strlen($hit[0]);
        $len = null;
        if (preg_match('/\/Length\s+(\d+)(?!\s+\d+\s+R)/', $dict, $lm)) $len = (int) $lm[1];
        $end = $len !== null && substr($pdf, $start + $len, 30) !== false && preg_match('/^\s*endstream/', substr($pdf, $start + $len, 30)) ? $start + $len : strpos($pdf, 'endstream', $start);
        if ($end === false) continue;
        $data = substr($pdf, $start, $end - $start);
        if (preg_match('/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/', $dict)) continue;
        // Filtres appliqués dans l'ordre où ils sont déclarés
        preg_match_all('/\/(ASCII85Decode|ASCIIHexDecode|FlateDecode|A85|AHx|Fl)\b/', preg_match('/\/Filter\s*(\[[^\]]*\]|\/\w+)/', $dict, $fm) ? $fm[1] : '', $filters);
        $ok = true;
        foreach ($filters[1] as $f) {
            if ($f === 'ASCII85Decode' || $f === 'A85') $data = pdf_a85($data);
            elseif ($f === 'ASCIIHexDecode' || $f === 'AHx') $data = pdf_hex(rtrim(trim($data), '>'));
            else {
                $d = @gzuncompress($data);
                if ($d === false) $d = @gzinflate(substr($data, 2));
                if ($d === false) $d = @gzuncompress(rtrim($data, "\r\n"));
                if ($d === false) { $ok = false; break; }
                $data = $d;
            }
        }
        if (!$ok) continue;
        $out[] = ['dict' => $dict, 'data' => $data];
    }
    return $out;
}
function pdf_a85(string $s): string
{
    $s = preg_replace('/\s+/', '', $s);
    if (str_starts_with($s, '<~')) $s = substr($s, 2);
    $p = strpos($s, '~>'); if ($p !== false) $s = substr($s, 0, $p);
    $out = ''; $tuple = []; $n = strlen($s);
    for ($i = 0; $i < $n; $i++) {
        $c = $s[$i];
        if ($c === 'z' && !$tuple) { $out .= "\0\0\0\0"; continue; }
        $tuple[] = ord($c) - 33;
        if (count($tuple) === 5) { $v = 0; foreach ($tuple as $t) $v = $v * 85 + $t; $out .= pack('N', $v & 0xFFFFFFFF); $tuple = []; }
    }
    if ($tuple) { $k = count($tuple); while (count($tuple) < 5) $tuple[] = 84; $v = 0; foreach ($tuple as $t) $v = $v * 85 + $t; $out .= substr(pack('N', $v & 0xFFFFFFFF), 0, $k - 1); }
    return $out;
}
function pdf_hex(string $h): string { $h = preg_replace('/[^0-9a-fA-F]/', '', $h); if (strlen($h) % 2) $h .= '0'; return (string) hex2bin($h); }
function pdf_unescape(string $s): string
{
    return preg_replace_callback('/\\\\([nrtbf()\\\\]|[0-7]{1,3}|\r?\n)/', function ($m) {
        $c = $m[1];
        if (ctype_digit($c)) return chr(octdec($c) & 255);
        return ['n' => "\n", 'r' => "\r", 't' => "\t", 'b' => "\x08", 'f' => "\f", '(' => '(', ')' => ')', '\\' => '\\'][$c] ?? '';
    }, $s);
}
function pdf_utf16(string $bytes): string { return (string) @mb_convert_encoding($bytes, 'UTF-8', 'UTF-16BE'); }
function pdf_text(string $pdf): string
{
    $streams = pdf_streams($pdf);
    // Tables ToUnicode (polices composites) : fusionnées, suffisant pour l'indexation
    $map1 = []; $map2 = [];
    foreach ($streams as $s) {
        if (!str_contains($s['data'], 'beginbfchar') && !str_contains($s['data'], 'beginbfrange')) continue;
        $d = $s['data'];
        if (preg_match_all('/beginbfchar(.*?)endbfchar/s', $d, $bc)) foreach ($bc[1] as $blk) {
            preg_match_all('/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/', $blk, $pp, PREG_SET_ORDER);
            foreach ($pp as $p) { $src = strtolower($p[1]); $dst = pdf_utf16(pdf_hex($p[2])); if (strlen($src) <= 2) $map1[hexdec($src)] = $dst; else $map2[hexdec($src)] = $dst; }
        }
        if (preg_match_all('/beginbfrange(.*?)endbfrange/s', $d, $br)) foreach ($br[1] as $blk) {
            preg_match_all('/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/', $blk, $pp, PREG_SET_ORDER);
            foreach ($pp as $p) {
                $a = hexdec($p[1]); $b = hexdec($p[2]); $two = strlen($p[1]) > 2;
                if ($b - $a > 5000) continue;
                if ($p[3][0] === '<') {
                    $base = pdf_hex(trim($p[3], '<>'));
                    $code = strlen($base) >= 2 ? unpack('n', substr($base, -2))[1] : ord($base);
                    for ($c = $a; $c <= $b; $c++) { $ch = pdf_utf16(substr($base, 0, -2) . pack('n', $code + $c - $a)); if ($two) $map2[$c] = $ch; else $map1[$c] = $ch; }
                } else {
                    preg_match_all('/<([0-9a-fA-F]+)>/', $p[3], $arr);
                    foreach ($arr[1] as $k => $h) { $ch = pdf_utf16(pdf_hex($h)); if ($two) $map2[$a + $k] = $ch; else $map1[$a + $k] = $ch; }
                }
            }
        }
    }
    $decode = function (string $bytes, bool $hex) use ($map1, $map2): string {
        if ($hex && $map2 && strlen($bytes) % 2 === 0) { $o = ''; foreach (unpack('n*', $bytes) as $c) $o .= $map2[$c] ?? ''; return $o; }
        if (str_starts_with($bytes, "\xFE\xFF")) return pdf_utf16(substr($bytes, 2));
        if ($map1) { $o = ''; for ($i = 0, $n = strlen($bytes); $i < $n; $i++) $o .= $map1[ord($bytes[$i])] ?? mb_convert_encoding($bytes[$i], 'UTF-8', 'Windows-1252'); return $o; }
        return mb_convert_encoding($bytes, 'UTF-8', 'Windows-1252');
    };
    $out = '';
    foreach ($streams as $s) {
        $d = $s['data'];
        if (!str_contains($d, 'BT') || str_contains($d, 'begincmap')) continue;
        if (!preg_match_all('/BT(.*?)ET/s', $d, $blocks)) continue;
        foreach ($blocks[1] as $blk) {
            // Chaînes littérales (…), hexadécimales <…>, tableaux TJ et retours à la ligne (Td, T*, ')
            preg_match_all('/\((?:\\\\.|[^\\\\)])*\)|<[0-9a-fA-F\s]*>|T[dD*]|\'|"/s', $blk, $tok);
            $line = '';
            foreach ($tok[0] as $t) {
                if ($t[0] === '(') $line .= $decode(pdf_unescape(substr($t, 1, -1)), false);
                elseif ($t[0] === '<') $line .= $decode(pdf_hex(substr($t, 1, -1)), true);
                else { $out .= $line . ($t === 'Td' || $t === 'TD' ? ' ' : "\n"); $line = ''; }
            }
            $out .= $line . "\n";
        }
        if (strlen($out) > MAX_CHARS) break;
    }
    return preg_replace(["/[ \t]+/", "/\n\s*\n+/"], [' ', "\n"], $out);
}

/** Requête FTS5 sûre : chaque mot devient un préfixe entre guillemets */
function fts_match(string $q): ?string
{
    $terms = array_slice(array_values(array_filter(array_map(fn($t) => trim(str_replace('"', '', $t)), preg_split('/\s+/u', $q)), fn($t) => mb_strlen($t) >= 2)), 0, 8);
    return $terms ? implode(' ', array_map(fn($t) => '"' . $t . '"*', $terms)) : null;
}
