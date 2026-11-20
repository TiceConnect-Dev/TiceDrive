<?php
/* TOTP (RFC 6238) : compatible Google Authenticator, Microsoft Authenticator, FreeOTP, Aegis… */
declare(strict_types=1);

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32_encode(string $bin): string
{
    $bits = ''; foreach (str_split($bin) as $c) $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
    $out = ''; foreach (str_split($bits, 5) as $chunk) $out .= B32[bindec(str_pad($chunk, 5, '0'))];
    return $out;
}
function b32_decode(string $s): string
{
    $s = preg_replace('/[^A-Z2-7]/', '', strtoupper($s)); $bits = '';
    foreach (str_split($s) as $c) $bits .= str_pad(decbin(strpos(B32, $c)), 5, '0', STR_PAD_LEFT);
    $out = ''; foreach (str_split($bits, 8) as $b) if (strlen($b) === 8) $out .= chr(bindec($b));
    return $out;
}
function hotp(string $key, int $counter): string
{
    $h = hash_hmac('sha1', pack('J', $counter), $key, true);
    $o = ord($h[19]) & 15;
    $n = ((ord($h[$o]) & 127) << 24) | (ord($h[$o + 1]) << 16) | (ord($h[$o + 2]) << 8) | ord($h[$o + 3]);
    return str_pad((string) ($n % 1000000), 6, '0', STR_PAD_LEFT);
}
function totp_secret(): string { return b32_encode(random_bytes(20)); }
function totp_verify(?string $secret, $code, int $window = 1): bool
{
    $code = preg_replace('/\D/', '', (string) $code);
    if (strlen($code) !== 6 || !$secret) return false;
    $key = b32_decode($secret); $t = intdiv(time(), 30);
    for ($w = -$window; $w <= $window; $w++) if (hash_equals(hotp($key, $t + $w), $code)) return true;
    return false;
}
function totp_uri(string $secret, string $account, string $issuer): string
{
    return 'otpauth://totp/' . rawurlencode($issuer) . ':' . rawurlencode($account) . "?secret=$secret&issuer=" . rawurlencode($issuer) . '&algorithm=SHA1&digits=6&period=30';
}
