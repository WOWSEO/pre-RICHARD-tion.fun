import { Buffer } from "buffer";

// Solana web3.js + wallet adapter packages can touch Buffer during module load.
// Static imports are evaluated before this file's body runs, so the app itself
// is loaded through ./bootstrap only after Buffer exists on globalThis.
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

// A few wallet dependencies also check process.env in the browser.
if (typeof globalThis.process === "undefined") {
  (globalThis as unknown as { process: { env: Record<string, string> } }).process = { env: {} };
}

void import("./bootstrap");
