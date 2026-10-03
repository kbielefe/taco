import { createVerify, X509Certificate } from "node:crypto";

const SKEW_MS = 150_000;

/** Amazon's skill requests are signed by a cert hosted on this path. */
export function signatureCertUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "s3.amazonaws.com" &&
    url.port === "" &&
    url.pathname.startsWith("/echo.api/")
  );
}

export function timestampFresh(timestamp: string | undefined, now: Date): boolean {
  if (!timestamp) {
    return false;
  }
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) {
    return false;
  }
  return Math.abs(now.getTime() - at) <= SKEW_MS;
}

export async function verifyAlexaSignature(input: {
  body: string;
  signature: string | undefined;
  certUrl: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!input.signature || !input.certUrl || !signatureCertUrlAllowed(input.certUrl)) {
    return false;
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.certUrl);
  if (!response.ok) {
    return false;
  }
  const pem = await response.text();
  const leaf = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!leaf) {
    return false;
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(leaf);
  } catch {
    return false;
  }
  const san = cert.subjectAltName ?? "";
  if (!san.includes("DNS:echo-api.amazon.com") || Date.parse(cert.validTo) < Date.now()) {
    return false;
  }
  try {
    return createVerify("RSA-SHA1").update(input.body).verify(cert.publicKey, Buffer.from(input.signature, "base64"));
  } catch {
    return false;
  }
}
