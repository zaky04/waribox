// Écriture minimale de classeurs Excel (.xlsx), sans dépendance.
//
// Pourquoi : la bibliothèque SheetJS (`xlsx`) n'est plus mise à jour sur npm et porte deux
// failles connues (dont une de déni de service à la LECTURE de fichiers). WariBox n'a jamais
// besoin de lire un classeur, seulement d'en produire — quelques onglets de tableaux de
// nombres et de textes. Un .xlsx est une archive ZIP de fichiers XML : écrire celle-ci
// directement est plus court que de garder 400 Ko de bibliothèque vulnérable.
//
// Couvre exactement ce qu'utilisent les rapports : des onglets nommés, une ligne d'en-têtes
// (les clés des objets, dans l'ordre d'apparition), puis une ligne par objet ; nombres, textes,
// booléens, cellules vides. Pas de formules, de styles ni de dates typées (une date est un texte).

export type XlsxCell = string | number | boolean | Date | null | undefined;
export interface XlsxSheet {
  name: string;
  rows: Record<string, unknown>[];
}

const encoder = new TextEncoder();

// ---- ZIP (méthode « stockée », sans compression) ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

function zip(files: { path: string; content: string }[], now = new Date()): Uint8Array {
  const { date, time } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  for (const file of files) {
    const name = encoder.encode(file.path);
    const data = encoder.encode(file.content);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version nécessaire
    local.setUint16(6, 0x0800, true); // noms de fichiers en UTF-8
    local.setUint16(8, 0, true); // méthode : stockée
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const localOffset = offset;
    push(new Uint8Array(local.buffer));
    push(name);
    push(data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true); // version créatrice
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, localOffset, true);
    central.push(new Uint8Array(entry.buffer), name);
  }
  const centralStart = offset;
  for (const part of central) push(part);
  const centralSize = offset - centralStart;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  push(new Uint8Array(end.buffer));

  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---- XML ----

// Caractères interdits en XML 1.0 (contrôles sauf tabulation/retours) : un seul suffit à rendre le fichier illisible.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Lettres de colonne : 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// Excel : 31 caractères maximum, jamais [ ] : * ? / \ , ni vide, ni commençant/finissant par une apostrophe ; nom unique.
export function sanitizeSheetName(name: string, taken: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Feuille";
  let candidate = base;
  let i = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${i++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

function cellXml(ref: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : "";
  if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (text === "") return "";
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(rows: Record<string, unknown>[]): string {
  // En-têtes : union des clés dans l'ordre d'apparition (comme json_to_sheet de SheetJS).
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const widths = headers.map((h) => h.length);
  const bodyRows: string[] = [];
  if (headers.length > 0) {
    bodyRows.push(`<row r="1">${headers.map((h, c) => cellXml(`${columnLetters(c)}1`, h)).join("")}</row>`);
    rows.forEach((row, r) => {
      const cells = headers.map((h, c) => {
        const value = row[h];
        const len = value === null || value === undefined ? 0 : String(value).length;
        if (len > widths[c]!) widths[c] = len;
        return cellXml(`${columnLetters(c)}${r + 2}`, value);
      });
      bodyRows.push(`<row r="${r + 2}">${cells.join("")}</row>`);
    });
  }
  const cols =
    headers.length > 0
      ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, w + 2))}" customWidth="1"/>`).join("")}</cols>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${bodyRows.join("")}</sheetData></worksheet>`;
}

/** Construit les octets d'un fichier .xlsx. Au moins un onglet (Excel refuse un classeur vide). */
export function buildXlsxBytes(sheets: XlsxSheet[], now = new Date()): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: "Feuille", rows: [] }];
  const taken = new Set<string>();
  const names = list.map((s) => sanitizeSheetName(s.name, taken));

  const files = [
    {
      path: "[Content_Types].xml",
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `</Types>`,
    },
    {
      path: "_rels/.rels",
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      path: "xl/workbook.xml",
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `</Relationships>`,
    },
    ...list.map((s, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s.rows) })),
  ];
  return zip(files, now);
}
