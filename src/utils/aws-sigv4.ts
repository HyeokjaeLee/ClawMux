import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

export interface SignableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const SERVICE = "bedrock";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hmacSha256Hex(key: Buffer | string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/**
 * URI-encode per RFC 3986 (AWS-strict).
 * Encodes everything except unreserved characters: A-Z a-z 0-9 - _ . ~
 */
function awsUriEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

/**
 * Build canonical URI with double-encoding (standard for non-S3 services).
 */
function buildCanonicalUri(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/";

  const segments = pathname.split("/");
  return segments
    .map((segment) => (segment === "" ? "" : awsUriEncode(awsUriEncode(segment))))
    .join("/");
}

function formatDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export function signRequest(
  request: SignableRequest,
  credentials: AwsCredentials,
  now?: Date,
): Record<string, string> {
  const date = now ?? new Date();
  const dateStamp = formatDateStamp(date);
  const amzDate = formatAmzDate(date);

  const url = new URL(request.url);
  const canonicalUri = buildCanonicalUri(url.pathname);

  const sortedParams = [...url.searchParams.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const canonicalQueryString = sortedParams
    .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
    .join("&");

  const payloadHash = sha256(request.body);

  const headersToSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    headersToSign[k.toLowerCase()] = v.trim();
  }
  headersToSign["host"] = url.host;
  headersToSign["x-amz-date"] = amzDate;
  headersToSign["x-amz-content-sha256"] = payloadHash;

  if (credentials.sessionToken) {
    headersToSign["x-amz-security-token"] = credentials.sessionToken;
  }

  const sortedHeaderKeys = Object.keys(headersToSign).sort();

  const canonicalHeaders =
    sortedHeaderKeys.map((k) => `${k}:${headersToSign[k]}`).join("\n") + "\n";
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    request.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${credentials.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    credentials.secretAccessKey,
    dateStamp,
    credentials.region,
    SERVICE,
  );
  const signature = hmacSha256Hex(signingKey, stringToSign);

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const result: Record<string, string> = {
    Authorization: authorization,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };

  if (credentials.sessionToken) {
    result["x-amz-security-token"] = credentials.sessionToken;
  }

  return result;
}

export function extractRegionFromUrl(url: string): string | undefined {
  const match = url.match(/\.([a-z0-9-]+)\.amazonaws\.com/);
  return match?.[1];
}
