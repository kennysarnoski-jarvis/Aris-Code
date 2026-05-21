/**
 * Slice M.2 / Slice J.3 — `sanitizeProviderErrorForUi` tests.
 *
 * Two layers of pinning, both load-bearing:
 *
 *   1. **Behavioral** — the sanitizer itself: redacts bearer/sk- keys
 *      and long hex/base64 blobs, collapses newlines, caps at 512
 *      chars. If a future refactor weakens any of these, the bus
 *      starts shipping raw provider errors (auth headers, prompt
 *      echoes, stack traces) to the renderer where they land in
 *      screenshots, browser history, or shared error reports.
 *
 *   2. **Structural** — both Aris-path call sites
 *      (`ArisAgentRunner.ts` + `ArisAdapter.ts`) must import the
 *      sanitizer and pass user-facing error strings through it
 *      before publishing. The DeepSeek path did this from Slice J.3;
 *      Round 4 caught the Aris path was missed (H-4A + H-4B). The
 *      structural assertions trip if a future edit yanks the wrap
 *      from either provider — the behavioral tests above can't
 *      catch a missing call site, only the source-grep can.
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SANITIZED_ERROR_MAX_CHARS, sanitizeProviderErrorForUi } from "./DeepSeekAgentRunner.ts";

describe("sanitizeProviderErrorForUi — behavior", () => {
  it("passes a clean short message through unchanged", () => {
    expect(sanitizeProviderErrorForUi("connection refused")).toBe("connection refused");
  });

  it("redacts sk- API keys", () => {
    const raw = "401 Unauthorized: sk-test-1234567890abcdefghijkl rejected";
    const out = sanitizeProviderErrorForUi(raw);
    expect(out).not.toContain("sk-test-1234567890abcdefghijkl");
    expect(out).toContain("<redacted>");
  });

  it("redacts Bearer tokens", () => {
    const raw = "401 invalid auth: Bearer eyJhbGciOiJIUzI1NiJ9.fake-token-1234567890.payload";
    const out = sanitizeProviderErrorForUi(raw);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("<redacted>");
  });

  it("redacts long hex blobs (32+ chars — looks like a digest or key)", () => {
    const raw = "checksum mismatch: 0123456789abcdef0123456789abcdef00 vs expected";
    const out = sanitizeProviderErrorForUi(raw);
    expect(out).toContain("<redacted>");
  });

  it("redacts long base64 blobs (40+ chars — looks like a serialized token)", () => {
    const raw = `error reading body: abcdefghijklmnopqrstuvwxyz0123456789ABCDEF+/= bytes`;
    const out = sanitizeProviderErrorForUi(raw);
    expect(out).toContain("<redacted>");
  });

  it("collapses newlines into a single line", () => {
    const raw = "first line\nsecond line\r\nthird line";
    const out = sanitizeProviderErrorForUi(raw);
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out).toBe("first line second line third line");
  });

  it("caps overlong input at SANITIZED_ERROR_MAX_CHARS with an ellipsis", () => {
    // Use a fixture that's long but NOT token-shaped — long runs of a
    // single character OR long contiguous alphanumeric blobs match
    // the TOKEN_LIKE_RE base64 branch and get redacted before the cap
    // kicks in. Words-with-spaces won't match any token branch.
    const word = "alpha beta gamma delta ";
    const raw = word.repeat(Math.ceil((SANITIZED_ERROR_MAX_CHARS + 100) / word.length));
    const out = sanitizeProviderErrorForUi(raw);
    // The output is the cap-length slice + a one-character ellipsis,
    // so length is SANITIZED_ERROR_MAX_CHARS + 1.
    expect(out.length).toBe(SANITIZED_ERROR_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("redacts BEFORE capping (so a long token at the end can't slip past)", () => {
    // Construct an input where the only token-shaped substring is near
    // the very end, past the cap boundary. The sanitizer must redact
    // first, then slice — if it sliced first the token would survive.
    const filler = "x".repeat(SANITIZED_ERROR_MAX_CHARS - 50);
    const raw = `${filler} sk-this-key-must-be-redacted-aaaaaaaa more text`;
    const out = sanitizeProviderErrorForUi(raw);
    expect(out).not.toContain("sk-this-key-must-be-redacted");
  });
});

describe("sanitizeProviderErrorForUi — structural parity (H-4A, H-4B)", () => {
  // These tests trip if a future refactor removes the sanitizer wrap
  // from either Aris-path publish site. The wrap landing is a
  // source-level claim that lint/typecheck can't enforce on its own.
  const layersDir = path.dirname(new URL(import.meta.url).pathname);

  it("ArisAgentRunner.ts imports and applies sanitizeProviderErrorForUi (H-4A)", async () => {
    const src = await readFile(path.join(layersDir, "ArisAgentRunner.ts"), "utf-8");
    expect(src).toContain(`from "./DeepSeekAgentRunner.ts"`);
    expect(src).toContain("sanitizeProviderErrorForUi");
    // The one publish site in ArisAgentRunner.ts must run the message
    // through the sanitizer. Direct `errorMessage: errMsg }` (raw bind)
    // is the regression shape Round 4 caught.
    expect(src).toMatch(/errorMessage:\s*sanitizeProviderErrorForUi\(/);
    expect(src).not.toMatch(/errorMessage:\s*errMsg\s*\}/);
  });

  it("ArisAdapter.ts imports and applies sanitizeProviderErrorForUi (H-4B)", async () => {
    const src = await readFile(path.join(layersDir, "ArisAdapter.ts"), "utf-8");
    expect(src).toContain(`from "./DeepSeekAgentRunner.ts"`);
    expect(src).toContain("sanitizeProviderErrorForUi(err.message)");
    // Both publishes (aris.error + aris.turn.failed) must use the
    // sanitized binding. The DeepSeek path binds once into
    // `safeMessage` and reuses; mirror that here. Raw `err.message`
    // anywhere in a `message:` or `errorMessage:` payload field is
    // the regression shape Round 4 caught.
    expect(src).not.toMatch(/message:\s*err\.message\b/);
    expect(src).not.toMatch(/errorMessage:\s*err\.message\b/);
  });
});
