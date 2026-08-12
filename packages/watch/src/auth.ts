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

/**
 * The capability token for one notice.
 *
 * There is no account system and none is needed: a notice link is a capability,
 * unguessable and scoped to exactly one record. It grants nothing else — not the
 * notice list, not the targets, not another notice.
 *
 * Derived rather than stored, so no schema change and no second thing to keep in
 * step. The consequence is that rotating the secret invalidates every link
 * already sent, which is the correct blast radius for a credential that lives in
 * other people's inboxes.
 */
export async function noticeLinkToken(noticeId: string, secret: string): Promise<string> {
  return hmacHex(`notice:${noticeId}`, secret);
}

export async function verifyNoticeLinkToken(noticeId: string, supplied: string | null, secret: string): Promise<boolean> {
  if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  return timingSafeEqual(supplied.toLowerCase(), await noticeLinkToken(noticeId, secret));
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
