// Lecteur minimal de classeurs Excel (.xlsx) : la première feuille, en tableau de texte. Sert à importer un catalogue.
// Écrit ici plutôt que d'ajouter la bibliothèque xlsx : sa version publiée sur npm a des failles connues à la LECTURE
// (précisément ce qu'on ferait d'un fichier fourni par l'utilisateur). Un .xlsx est une archive zip de fichiers XML ;
// on n'en lit que ce qu'il faut (chaînes partagées, première feuille) et on borne tout (taille, nombre d'entrées).

const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 30 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_COLUMNS = 200;

export class XlsxReadError extends Error {}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Fin du répertoire central : signature 0x06054b50, dans les 64 Ko + 22 derniers octets.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxReadError("not a zip archive");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new XlsxReadError("too many entries");
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new XlsxReadError("corrupt zip directory");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new XlsxReadError("entry too large");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.localOffset;
  if (start + 30 > bytes.length || view.getUint32(start, true) !== 0x04034b50) throw new XlsxReadError("corrupt zip entry");
  const dataStart = start + 30 + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new XlsxReadError("unsupported compression");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel();
      throw new XlsxReadError("entry too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return new TextDecoder().decode(out);
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** « text » de toutes les balises <t> d'un bloc (une cellule de texte riche en contient plusieurs). */
function textOf(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]!);
  return out;
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Première feuille d'un classeur Excel, en tableau de texte (cellules vides = ""). */
export async function readXlsxFirstSheet(bytes: Uint8Array): Promise<string[][]> {
  const entries = readZipEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  const read = async (name: string) => {
    const entry = byName.get(name);
    return entry ? readEntry(bytes, entry) : null;
  };

  // La première feuille déclarée dans le classeur ; à défaut, la première du dossier worksheets.
  let sheetPath: string | null = null;
  const workbook = await read("xl/workbook.xml");
  const rels = await read("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const sheetTag = /<sheet\b[^>]*>/.exec(workbook)?.[0];
    const rid = sheetTag && /r:id="([^"]+)"/.exec(sheetTag)?.[1];
    if (rid) {
      for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        if (new RegExp(`Id="${rid}"`).test(rel[0])) {
          const target = /Target="([^"]+)"/.exec(rel[0])?.[1];
          if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
        }
      }
    }
  }
  if (!sheetPath || !byName.has(sheetPath)) {
    sheetPath = entries.map((e) => e.name).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0] ?? null;
  }
  if (!sheetPath) throw new XlsxReadError("no worksheet");

  const shared: string[] = [];
  const sharedXml = await read("xl/sharedStrings.xml");
  if (sharedXml) for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!));

  const sheetXml = (await read(sheetPath))!;
  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(/\br="(\d+)"/.exec(rowMatch[1]!)?.[1] ?? rows.length + 1) - 1;
    if (rowNumber >= MAX_ROWS) throw new XlsxReadError("too many rows");
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1]!;
      const body = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const col = ref ? columnIndex(ref) : cells.length;
      if (col >= MAX_COLUMNS) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let value = "";
      if (type === "s") value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      if (type === "b") value = value === "1" ? "true" : "false";
      while (cells.length <= col) cells.push("");
      cells[col] = value;
    }
    while (rows.length < rowNumber) rows.push([]);
    rows[rowNumber] = cells;
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
