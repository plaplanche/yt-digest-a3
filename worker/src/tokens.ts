export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A node token: `ytd_node_` and 32 random bytes in base64url (43 characters). */
export const newNodeToken = (): string => `ytd_node_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;

/** A random value of `bytes` bytes in base64url. */
export const randomToken = (bytes = 32): string => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** Encrypts with AES-GCM under the base64 32-byte `keyBase64`: `v1:` and the base64 of the random 12-byte IV followed by the ciphertext. */
export async function encryptSecret(plain: string, keyBase64: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0)), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return `v1:${base64(new Uint8Array([...iv, ...cipher]))}`;
}
