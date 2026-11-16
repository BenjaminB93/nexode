// Lecture d'une archive ZIP en mémoire : entrées stockées ou compressées (deflate), sans ZIP64 ni chiffrement. Pur, sans I/O.
import { crc32, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {}

export const isZip = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;

// Entrées demandées (par nom exact) → contenu décompressé ; une entrée absente de l'archive est absente du résultat.
// maxBytes : taille décompressée maximale par entrée (protège la mémoire contre une archive piégée).
export function readZip(bytes: Uint8Array, names: readonly string[], maxBytes: number): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (why = 'archive ZIP illisible') => new ZipError(why);
  // Fin du répertoire central : dans les 22 derniers octets, plus un éventuel commentaire d'archive (65 535 au plus).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad();
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw bad('archive ZIP64 non prise en charge');

  const want = new Set(names);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!want.has(name)) continue;
    if (flags & 1) throw bad(`${name} : entrée chiffrée`);
    if (size > maxBytes) throw bad(`${name} : trop volumineux`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > buf.length) throw bad();
    const raw = buf.subarray(start, start + packed);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: maxBytes }); } catch { throw bad(`${name} : contenu corrompu`); }
    } else throw bad(`${name} : compression non prise en charge`);
    if (data.length !== size || crc32(data) !== crc) throw bad(`${name} : contenu corrompu`);
    out.set(name, data);
  }
  return out;
}
