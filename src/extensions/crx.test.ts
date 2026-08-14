import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { encodeCrxId, extractZip, firstField, idFromPath, idFromPublicKey, isCrx, parseCrx } from "./crx.ts";

/** Length-delimited protobuf field, the only wire type the CRX header uses. */
function field(number: number, payload: Uint8Array): Uint8Array {
  const key = varint(BigInt((number << 3) | 2));
  const length = varint(BigInt(payload.length));
  const out = new Uint8Array(key.length + length.length + payload.length);
  out.set(key, 0);
  out.set(length, key.length);
  out.set(payload, key.length + length.length);
  return out;
}

function varint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    bytes.push(v > 0n ? byte | 0x80 : byte);
  } while (v > 0n);
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function crx3(header: Uint8Array, zip: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(12);
  prefix.set(new TextEncoder().encode("Cr24"), 0);
  new DataView(prefix.buffer).setUint32(4, 3, true);
  new DataView(prefix.buffer).setUint32(8, header.length, true);
  return concat(prefix, header, zip);
}

const SAMPLE_ZIP = zipSync({
  "manifest.json": new TextEncoder().encode('{"name":"Sample","version":"1.0","manifest_version":2}'),
  "nested/page.html": new TextEncoder().encode("<h1>hi</h1>"),
});

describe("encodeCrxId", () => {
  test("maps every nibble into a..p", () => {
    expect(encodeCrxId(new Uint8Array(16).fill(0x00))).toBe("a".repeat(32));
    expect(encodeCrxId(new Uint8Array(16).fill(0xff))).toBe("p".repeat(32));
    expect(encodeCrxId(new Uint8Array([0x01, 0x23, 0x45, 0x67]))).toBe("abcdefgh");
  });

  test("ids are 32 characters and stable for a key", () => {
    const key = new Uint8Array([1, 2, 3, 4, 5]);
    const id = idFromPublicKey(key);
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(idFromPublicKey(key)).toBe(id);
    // Same derivation Chrome uses: first 16 bytes of SHA-256 over the key.
    expect(id).toBe(encodeCrxId(new Uint8Array(createHash("sha256").update(key).digest().subarray(0, 16))));
  });

  test("unpacked ids follow the absolute path, and normalize it", () => {
    expect(idFromPath("/tmp/ext")).toBe(idFromPath("/tmp/./ext"));
    expect(idFromPath("/tmp/ext")).not.toBe(idFromPath("/tmp/other"));
  });
});

describe("firstField", () => {
  test("finds a high field number past other fields", () => {
    const message = concat(
      field(2, new Uint8Array([9, 9])),
      field(10000, new TextEncoder().encode("signed")),
    );
    expect(new TextDecoder().decode(firstField(message, 10000)!)).toBe("signed");
  });

  test("returns null for an absent field and for a truncated message", () => {
    expect(firstField(field(1, new Uint8Array([1])), 7)).toBeNull();
    expect(firstField(new Uint8Array([0x8a, 0x8a]), 1)).toBeNull();
  });
});

describe("parseCrx", () => {
  test("takes the id from the signed header and the zip from the tail", () => {
    const crxId = new Uint8Array(16).fill(0x10);
    const header = field(10000, field(1, crxId));
    const parsed = parseCrx(crx3(header, SAMPLE_ZIP));
    expect(parsed.version).toBe(3);
    expect(parsed.id).toBe(encodeCrxId(crxId));
    expect(parsed.zip).toEqual(SAMPLE_ZIP);
  });

  test("falls back to the first RSA proof's public key", () => {
    const publicKey = new Uint8Array([7, 7, 7, 7]);
    const header = field(2, field(1, publicKey));
    expect(parseCrx(crx3(header, SAMPLE_ZIP)).id).toBe(idFromPublicKey(publicKey));
  });

  test("reads a CRX2 header", () => {
    const publicKey = new Uint8Array([3, 1, 4, 1, 5]);
    const signature = new Uint8Array([9, 2, 6]);
    const prefix = new Uint8Array(16);
    prefix.set(new TextEncoder().encode("Cr24"), 0);
    const view = new DataView(prefix.buffer);
    view.setUint32(4, 2, true);
    view.setUint32(8, publicKey.length, true);
    view.setUint32(12, signature.length, true);
    const parsed = parseCrx(concat(prefix, publicKey, signature, SAMPLE_ZIP));
    expect(parsed.version).toBe(2);
    expect(parsed.id).toBe(idFromPublicKey(publicKey));
    expect(parsed.zip).toEqual(SAMPLE_ZIP);
  });

  test("rejects a file that is not a CRX, and an unknown version", () => {
    expect(isCrx(SAMPLE_ZIP)).toBe(false);
    expect(() => parseCrx(SAMPLE_ZIP)).toThrow(/Cr24/);
    const prefix = new Uint8Array(12);
    prefix.set(new TextEncoder().encode("Cr24"), 0);
    new DataView(prefix.buffer).setUint32(4, 9, true);
    expect(() => parseCrx(concat(prefix, SAMPLE_ZIP))).toThrow(/version 9/);
  });
});

describe("extractZip", () => {
  test("writes entries under the destination", async () => {
    const dest = `/tmp/nb-crx-test-${Date.now()}`;
    await extractZip(SAMPLE_ZIP, dest);
    expect(await Bun.file(`${dest}/nested/page.html`).text()).toBe("<h1>hi</h1>");
  });

  test("refuses an entry that escapes the destination", async () => {
    const evil = zipSync({ "../escaped.txt": new TextEncoder().encode("no") });
    await expect(extractZip(evil, `/tmp/nb-crx-test-escape-${Date.now()}`)).rejects.toThrow(/escapes/);
  });
});
