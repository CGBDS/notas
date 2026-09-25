/* Cifrado local AES-GCM con clave derivada de la contraseña (PBKDF2) */
const CryptoBox = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function getSalt() {
    let s = localStorage.getItem('notas_salt');
    if (!s) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      s = btoa(String.fromCharCode(...bytes));
      localStorage.setItem('notas_salt', s);
    }
    return s;
  }

  async function deriveKeyFrom(password, saltB64) {
    const saltBytes = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 120000, hash: 'SHA-256' },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function deriveKey(password) {
    return deriveKeyFrom(password, getSalt());
  }

  function randomSaltB64() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes));
  }

  const b64 = buf => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
  };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;

  async function encryptJSON(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return JSON.stringify({ iv: b64(iv), data: b64(data) });
  }

  async function decryptJSON(key, payload) {
    const { iv, data } = JSON.parse(payload);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(unb64(iv)) }, key, unb64(data));
    return JSON.parse(dec.decode(plain));
  }

  return { sha256Hex, deriveKey, deriveKeyFrom, randomSaltB64, encryptJSON, decryptJSON };
})();
