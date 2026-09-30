/** Test helpers for Web Push: a VAPID key set and a browser-shaped subscription. */
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function vapid() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = (await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
  return { VAPID_PUBLIC_KEY: b64url(pub), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: 'mailto:test@example.com' }
}

export async function pushSubscription(endpoint: string) {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const pub = (await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer
  return { endpoint, expirationTime: null, keys: { p256dh: b64url(pub), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } }
}
