export async function verifyApiKey(request: Request, expected: string): Promise<boolean> {
  const value = request.headers.get("Authorization");
  if (!value?.startsWith("Bearer ")) return false;
  return timingSafeEqual(value.slice(7), expected);
}

export async function verifyHmacSignature(body: string, supplied: string | null, secret: string): Promise<boolean> {
  if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = await hmacHex(body, secret);
  return timingSafeEqual(supplied.toLowerCase(), expected);
}

export async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
