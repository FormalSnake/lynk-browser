// CRX unpacking and Chrome extension ids.
//
// A .crx is a small header in front of an ordinary zip. CRX3 states the header
// as protobuf, so the few fields we need (the signed header's crx_id, and the
// first RSA public key as a fallback) are read with a minimal wire-format
// walker rather than a protobuf runtime — the schema is four fields wide and
// frozen.
//
//   CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
//                   repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
//                   bytes signed_header_data = 10000; }
//   AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
//   SignedData { bytes crx_id = 1; }   // 16 bytes
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { unzipSync } from "fflate";

const MAGIC = "Cr24";

export interface CrxArchive {
  zip: Uint8Array;
  /** The id declared by the CRX itself, when the header carries one. */
  id: string | null;
  version: number;
}

/// Chrome's "mpdecimal" id encoding: each nibble of the 16-byte id becomes one
/// letter in a..p, giving the 32-character ids seen in the Web Store.
export function encodeCrxId(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes.slice(0, 16)) {
    out += String.fromCharCode(97 + (byte >> 4));
    out += String.fromCharCode(97 + (byte & 0x0f));
  }
  return out;
}

/// A packed extension's id is the first half of the SHA-256 of its public key.
export function idFromPublicKey(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest();
  return encodeCrxId(new Uint8Array(digest.subarray(0, 16)));
}

/// An unpacked extension has no key, so Chrome derives the id from the absolute
/// path of the directory it was loaded from. Same input, same id across
/// restarts, which is what the registry and the extension origin need.
export function idFromPath(path: string): string {
  const digest = createHash("sha256").update(resolve(path)).digest();
  return encodeCrxId(new Uint8Array(digest.subarray(0, 16)));
}

export function isCrx(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(0, 4)) === MAGIC;
}

export function parseCrx(bytes: Uint8Array): CrxArchive {
  if (!isCrx(bytes)) throw new Error("not a CRX archive (missing the Cr24 magic)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);

  if (version === 2) {
    // CRX2: two lengths, then the key, the signature, and the zip.
    const keyLength = view.getUint32(8, true);
    const sigLength = view.getUint32(12, true);
    const keyAt = 16;
    const zipAt = keyAt + keyLength + sigLength;
    if (zipAt > bytes.length) throw new Error("CRX2 header runs past the end of the file");
    return {
      zip: bytes.subarray(zipAt),
      id: idFromPublicKey(bytes.subarray(keyAt, keyAt + keyLength)),
      version,
    };
  }

  if (version !== 3) throw new Error(`unsupported CRX version ${version}`);

  const headerLength = view.getUint32(8, true);
  const headerAt = 12;
  const zipAt = headerAt + headerLength;
  if (zipAt > bytes.length) throw new Error("CRX3 header runs past the end of the file");
  const header = bytes.subarray(headerAt, zipAt);

  const signedData = firstField(header, 10000);
  const crxId = signedData ? firstField(signedData, 1) : null;
  if (crxId && crxId.length === 16) {
    return { zip: bytes.subarray(zipAt), id: encodeCrxId(crxId), version };
  }

  // No signed header: fall back to the first RSA proof's public key, which is
  // what the id would have been derived from anyway.
  const rsaProof = firstField(header, 2);
  const publicKey = rsaProof ? firstField(rsaProof, 1) : null;
  return {
    zip: bytes.subarray(zipAt),
    id: publicKey ? idFromPublicKey(publicKey) : null,
    version,
  };
}

/// Reads the first length-delimited field with the given number out of a
/// protobuf message. Other wire types are skipped, not decoded — nothing this
/// module needs is a varint or a fixed-width scalar.
export function firstField(message: Uint8Array, field: number): Uint8Array | null {
  let at = 0;
  while (at < message.length) {
    const [key, afterKey] = readVarint(message, at);
    if (afterKey < 0) return null;
    const number = Number(key >> 3n);
    const wireType = Number(key & 7n);
    at = afterKey;

    if (wireType === 2) {
      const [length, afterLength] = readVarint(message, at);
      if (afterLength < 0) return null;
      const end = afterLength + Number(length);
      if (end > message.length) return null;
      if (number === field) return message.subarray(afterLength, end);
      at = end;
    } else if (wireType === 0) {
      const [, next] = readVarint(message, at);
      if (next < 0) return null;
      at = next;
    } else if (wireType === 5) {
      at += 4;
    } else if (wireType === 1) {
      at += 8;
    } else {
      return null; // groups: not in this schema, and not worth guessing at
    }
  }
  return null;
}

/// Returns `[value, nextOffset]`, with `nextOffset < 0` on a truncated varint.
function readVarint(bytes: Uint8Array, at: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let cursor = at;
  while (cursor < bytes.length) {
    const byte = bytes[cursor]!;
    value |= BigInt(byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return [value, cursor];
    shift += 7n;
    if (shift > 63n) return [0n, -1];
  }
  return [0n, -1];
}

/// Writes a zip's entries under `dest`, refusing any name that would escape it.
export async function extractZip(zip: Uint8Array, dest: string): Promise<void> {
  const root = resolve(dest);
  const entries = unzipSync(zip);
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const path = resolve(root, name);
    if (path !== root && !path.startsWith(`${root}/`)) {
      throw new Error(`zip entry escapes the extension directory: ${name}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
  }
}
