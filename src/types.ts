export const STORE_FORMAT_VERSION = 1;

export const VERIFY_SCHEMES = ["sha256", "sha1"] as const;
export type VerifyScheme = (typeof VERIFY_SCHEMES)[number];

export const SIGNATURE_HEADERS = [
  "x-hub-signature-256",
  "x-hub-signature",
  "x-signature-256",
  "x-signature",
] as const;

export type Headers = Record<string, string>;

/** One captured webhook request, as stored on disk. */
export interface CaptureRecord {
  method: string;
  url: string;
  headers: Headers;
  /** The request body decoded for readability; JSON becomes an object. */
  body: string | Record<string, unknown>;
  /** The exact bytes received, utf8-decoded. Signature verification and replay use this, never the decoded form. */
  raw: string;
  receivedAt: string;
  remote: string;
}

/** Top-level on-disk store written by `hooktap listen --out`. */
export interface CaptureStore {
  formatVersion: number;
  name: string;
  captures: CaptureRecord[];
}

export interface ServeOptions {
  port?: number;
  host?: string;
  outPath?: string;
  name?: string;
  quiet?: boolean;
  /** Maximum accepted request body in bytes; larger requests get 413. Default 10 MiB. */
  maxBodyBytes?: number;
}

export interface CaptureServer {
  port: number;
  url: string;
  captures: CaptureRecord[];
  close(): Promise<void>;
}

export interface VerifyResult {
  valid: boolean;
  scheme: VerifyScheme | null;
  /** The digest exactly as the incoming header carried it. */
  headerValue: string | null;
  headerName: string | null;
  /** Computed HMAC hex digest for the chosen scheme. */
  computed: string;
  /** Present only when invalid: first differing hex nibble index. */
  firstDiff?: number;
}

export interface ReplayResult {
  url: string;
  status: number;
  headers: Headers;
  body: string;
}
