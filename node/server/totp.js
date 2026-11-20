'use strict';
// TOTP (RFC 6238) compatible Google Authenticator, Microsoft Authenticator, FreeOTP, Aegis…
const crypto = require('crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  s = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of s) { val = (val << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(b).digest();
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}
const generateSecret = () => b32encode(crypto.randomBytes(20));
function verify(secret, code, window = 1) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6 || !secret) return false;
  const key = b32decode(secret), t = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, t + w)), Buffer.from(code))) return true;
  }
  return false;
}
const uri = (secret, account, issuer) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { generateSecret, verify, uri, hotp, b32decode };
