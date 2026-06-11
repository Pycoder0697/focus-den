/* Generate a VAPID key pair for Focus Den Web Push. Run once:
 *     node push-backend/generate-vapid.mjs
 * Then:
 *   - VAPID_PUBLIC      → set as a worker secret AND paste into index.html (PUSH_VAPID_PUBLIC)
 *   - VAPID_PRIVATE_JWK → set as a worker secret only (keep private, never ship to the client)
 * Needs Node 18+ (built-in WebCrypto). No npm install required.
 */
import { webcrypto as c } from 'node:crypto';

const kp = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await c.subtle.exportKey('raw', kp.publicKey)); // 65-byte uncompressed point
const jwk = await c.subtle.exportKey('jwk', kp.privateKey);                    // { kty, crv, d, x, y }
const b64url = (b) => Buffer.from(b).toString('base64url');

console.log('\n=== VAPID_PUBLIC  (worker secret + index.html PUSH_VAPID_PUBLIC) ===');
console.log(b64url(pubRaw));
console.log('\n=== VAPID_PRIVATE_JWK  (worker secret ONLY — keep private) ===');
console.log(JSON.stringify(jwk));
console.log('\nSet them with:');
console.log('  wrangler secret put VAPID_PUBLIC');
console.log('  wrangler secret put VAPID_PRIVATE_JWK');
console.log('  wrangler secret put VAPID_SUBJECT   # e.g. mailto:you@example.com');
console.log('  wrangler secret put RTDB_URL        # https://…firebasedatabase.app');
console.log('  wrangler secret put RTDB_KEY        # the app\'s CLOUD.key\n');
