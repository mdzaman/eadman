/**
 * Strict CSP for the docs portal: no inline scripts or styles anywhere. The renderer embeds it as a
 * `<meta>`, but browsers ignore `frame-ancestors` there, so every host must also send it as a header.
 */
export const PORTAL_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self' https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Headers every portal host (the DocOps API, a CDN, nginx) sends with each file. */
export const PORTAL_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": PORTAL_CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
