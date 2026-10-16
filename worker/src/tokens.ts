export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A node token: `ytd_node_` and 32 random bytes in base64url (43 characters). */
export const newNodeToken = (): string => `ytd_node_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
