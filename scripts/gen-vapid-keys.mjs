#!/usr/bin/env node
/**
 * Generate a VAPID key pair for the admin page's Web Push alerts.
 *
 *   node scripts/gen-vapid-keys.mjs [mailto:you@example.com]
 *
 * Prints the three values the Worker expects. Store them as secrets:
 *   npx wrangler secret put VAPID_PUBLIC_KEY
 *   npx wrangler secret put VAPID_PRIVATE_KEY
 *   npx wrangler secret put VAPID_SUBJECT
 * (or add them to .dev.vars for `wrangler dev`). Public key = base64url of the
 * uncompressed P-256 point (what `applicationServerKey` wants); private key =
 * the JWK `d` parameter, which is what @block65/webcrypto-web-push signs with.
 * Rotating the pair invalidates every stored browser subscription — they have
 * to press "Enable notifications" again.
 */

const subject = process.argv[2] ?? 'mailto:you@example.com'
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const pub = await crypto.subtle.exportKey('raw', kp.publicKey)
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)

console.log(`VAPID_PUBLIC_KEY=${b64url(pub)}`)
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`)
console.log(`VAPID_SUBJECT=${subject}`)
