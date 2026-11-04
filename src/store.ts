import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STORE_FORMAT_VERSION, type CaptureRecord, type CaptureStore } from "./types.js";

export function emptyStore(name: string): CaptureStore {
  return { formatVersion: STORE_FORMAT_VERSION, name, captures: [] };
}

export function saveCaptures(store: CaptureStore, outPath: string): void {
  writeFileSync(outPath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function loadCaptures(path: string): CaptureStore {
  if (!existsSync(path)) {
    const err = new Error("capture store not found: " + path) as NodeJS.ErrnoException & { code?: string };
    err.code = "ENOENT";
    throw err;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CaptureStore>;
  if (raw.formatVersion !== STORE_FORMAT_VERSION) {
    throw new Error("unsupported store formatVersion: " + String(raw.formatVersion) + " (expected " + STORE_FORMAT_VERSION + ")");
  }
  if (!Array.isArray(raw.captures)) {
    throw new Error("store has no captures array");
  }
  return raw as CaptureStore;
}

export function describeRecord(r: CaptureRecord): string {
  const bodyLen = typeof r.body === "string" ? r.body.length : JSON.stringify(r.body).length;
  return r.method + " " + r.url + " (" + bodyLen + "B, " + r.receivedAt + ")";
}
