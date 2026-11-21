import type { Database } from "@gestion-boutique/database";
import { t } from "@gestion-boutique/i18n";
import type { PermissionSet } from "../domain/permissions";
import { addManualStockEntry } from "../services/StockService";
import { createCategory, createProduct, listCategories, listProducts, listAllVariants } from "../services/ProductsService";

// Import d'un catalogue depuis un tableur (CSV ou Excel enregistré en CSV) : le commerçant qui démarre n'a pas à
// ressaisir ses centaines de produits. Tout se déroule en trois temps : LIRE le fichier (tableau de cellules),
// PRÉVOIR ce qui sera créé, ignoré (déjà là) ou refusé (erreur ligne par ligne), puis IMPORTER ce qui est valide.
// La lecture d'un .xlsx est dans packages/reports (xlsxRead) ; ce module ne travaille que sur des tableaux de texte.

export type CsvTable = string[][];

/** Lit un CSV : séparateur « ; » « , » ou tabulation détecté sur l'en-tête, guillemets, retours à la ligne dans une cellule. */
export function parseCsv(input: string): CsvTable {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ";": 0, ",": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch as keyof typeof counts]++;
  }
  const delimiter = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0] : ";") as string;

  const rows: CsvTable = [];
  let row: string[] = [];
  let cell = "";
  inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

type Field = "name" | "salePrice" | "purchasePrice" | "category" | "barcode" | "unit" | "stock" | "taxRate" | "lowStockThreshold";

const ALIASES: Record<Field, string[]> = {
  name: ["nom", "nom du produit", "produit", "designation", "libelle", "article", "name", "product", "product name", "item"],
  salePrice: ["prix de vente", "prix de vente ttc", "prix vente", "pv", "prix", "tarif", "sale price", "selling price", "price", "pvttc", "prix ttc"],
  purchasePrice: ["prix d achat", "prix achat", "pa", "cout", "cout d achat", "purchase price", "cost", "buying price"],
  category: ["categorie", "famille", "rayon", "category", "type"],
  barcode: ["code barres", "code barre", "codebarre", "ean", "gtin", "barcode", "upc", "code"],
  unit: ["unite", "unit", "conditionnement"],
  stock: ["stock", "quantite", "qte", "stock initial", "quantite initiale", "qty", "quantity", "initial stock"],
  taxRate: ["tva", "taux tva", "taux de tva", "tax", "vat", "tax rate", "vat rate"],
  lowStockThreshold: ["seuil", "seuil alerte", "seuil d alerte", "alerte stock", "low stock", "min stock", "reorder level"],
};

/** Colonne de chaque champ dans l'en-tête (index), -1 si absente. */
export function mapHeader(header: string[]): Record<Field, number> {
  const normalized = header.map(norm);
  const result = {} as Record<Field, number>;
  for (const field of Object.keys(ALIASES) as Field[]) {
    result[field] = normalized.findIndex((h) => ALIASES[field].includes(h));
  }
  return result;
}

/** Nombre saisi à la française ou à l'anglaise : « 1 500 », « 1500,50 », « 1,500.50 ». null si illisible. */
export function parseNumber(value: string | undefined): number | null {
  if (value == null) return null;
  let s = value.replace(/[\s ]/g, "").replace(/[A-Za-zÀ-ÿ%$€£₦₵]+$/u, "");
  if (s === "") return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Les deux : le dernier est la virgule décimale, l'autre sépare les milliers.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma !== -1) {
    s = s.replace(",", ".");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface CatalogRow {
  /** Numéro de ligne dans le fichier (l'en-tête est la ligne 1). */
  line: number;
  name: string;
  salePrice: number;
  purchasePrice: number;
  category: string | null;
  barcode: string | null;
  unit: string | null;
  stock: number;
  taxRate: number | null;
  lowStockThreshold: number | null;
}

export interface RowProblem {
  line: number;
  name: string;
  message: string;
}

export interface CatalogPlan {
  toCreate: CatalogRow[];
  /** Déjà dans le catalogue (même nom ou même code-barres) ou répété dans le fichier : ignorés, jamais écrasés. */
  duplicates: RowProblem[];
  errors: RowProblem[];
  /** Colonnes reconnues, pour l'afficher à l'utilisateur. */
  recognized: string[];
  headerError: string | null;
}

export const MAX_IMPORT_ROWS = 5000;

/** Prévoit l'import sans rien écrire. `existing` : noms (en minuscules, sans accent) et codes-barres déjà en base. */
export function planCatalogImport(table: CsvTable, existing: { names: Set<string>; barcodes: Set<string> }): CatalogPlan {
  const plan: CatalogPlan = { toCreate: [], duplicates: [], errors: [], recognized: [], headerError: null };
  if (table.length === 0) {
    plan.headerError = t("catalogImport.errors.empty");
    return plan;
  }
  const columns = mapHeader(table[0]!);
  plan.recognized = (Object.keys(columns) as Field[]).filter((f) => columns[f] !== -1);
  if (columns.name === -1) {
    plan.headerError = t("catalogImport.errors.noNameColumn");
    return plan;
  }
  if (columns.salePrice === -1) {
    plan.headerError = t("catalogImport.errors.noPriceColumn");
    return plan;
  }
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    plan.headerError = t("catalogImport.errors.tooManyRows", { max: MAX_IMPORT_ROWS });
    return plan;
  }

  const seenNames = new Set(existing.names);
  const seenBarcodes = new Set(existing.barcodes);
  const cell = (row: string[], field: Field) => (columns[field] === -1 ? "" : (row[columns[field]] ?? "").trim());

  for (let i = 1; i < table.length; i++) {
    const raw = table[i]!;
    const line = i + 1;
    const name = cell(raw, "name");
    const problem = (message: string) => plan.errors.push({ line, name, message });
    if (!name) {
      problem(t("catalogImport.errors.nameMissing"));
      continue;
    }
    if (name.length > 120) {
      problem(t("catalogImport.errors.nameTooLong"));
      continue;
    }
    const salePriceRaw = cell(raw, "salePrice");
    const salePrice = parseNumber(salePriceRaw);
    if (salePrice === null) {
      problem(salePriceRaw === "" ? t("catalogImport.errors.priceMissing") : t("catalogImport.errors.priceInvalid", { value: salePriceRaw }));
      continue;
    }
    if (salePrice < 0) {
      problem(t("catalogImport.errors.priceNegative"));
      continue;
    }
    const purchaseRaw = cell(raw, "purchasePrice");
    const purchasePrice = purchaseRaw === "" ? 0 : parseNumber(purchaseRaw);
    if (purchasePrice === null || purchasePrice < 0) {
      problem(t("catalogImport.errors.purchaseInvalid", { value: purchaseRaw }));
      continue;
    }
    const stockRaw = cell(raw, "stock");
    const stock = stockRaw === "" ? 0 : parseNumber(stockRaw);
    if (stock === null || stock < 0) {
      problem(t("catalogImport.errors.stockInvalid", { value: stockRaw }));
      continue;
    }
    const taxRaw = cell(raw, "taxRate");
    const taxRate = taxRaw === "" ? null : parseNumber(taxRaw);
    if (taxRaw !== "" && (taxRate === null || taxRate < 0 || taxRate > 100)) {
      problem(t("catalogImport.errors.taxInvalid", { value: taxRaw }));
      continue;
    }
    const thresholdRaw = cell(raw, "lowStockThreshold");
    const threshold = thresholdRaw === "" ? null : parseNumber(thresholdRaw);
    if (thresholdRaw !== "" && (threshold === null || threshold < 0)) {
      problem(t("catalogImport.errors.thresholdInvalid", { value: thresholdRaw }));
      continue;
    }

    const barcode = cell(raw, "barcode") || null;
    const nameKey = norm(name);
    if (seenNames.has(nameKey)) {
      plan.duplicates.push({ line, name, message: t("catalogImport.duplicateName") });
      continue;
    }
    if (barcode && seenBarcodes.has(barcode)) {
      plan.duplicates.push({ line, name, message: t("catalogImport.duplicateBarcode", { barcode }) });
      continue;
    }
    seenNames.add(nameKey);
    if (barcode) seenBarcodes.add(barcode);
    plan.toCreate.push({
      line,
      name,
      salePrice,
      purchasePrice,
      category: cell(raw, "category") || null,
      barcode,
      unit: cell(raw, "unit") || null,
      stock: Math.floor(stock),
      taxRate,
      lowStockThreshold: threshold === null ? null : Math.floor(threshold),
    });
  }
  return plan;
}

/** Noms et codes-barres déjà en base, sous la forme attendue par `planCatalogImport`. */
export async function loadExistingCatalogKeys(db: Database): Promise<{ names: Set<string>; barcodes: Set<string> }> {
  const [products, variants] = await Promise.all([listProducts(db), listAllVariants(db)]);
  return {
    names: new Set(products.map((p) => norm(p.name))),
    barcodes: new Set(variants.map((v) => v.barcode).filter((b): b is string => !!b)),
  };
}

export interface ImportResult {
  created: number;
  stockAdded: number;
  failed: RowProblem[];
}

/**
 * Crée les produits prévus. Chaque produit est indépendant : un échec n'arrête pas les suivants, il est rapporté
 * avec son numéro de ligne. Le stock de départ (colonne facultative) entre à l'emplacement `stockLocationId`.
 */
export async function runCatalogImport(
  db: Database,
  rows: CatalogRow[],
  context: { userId: number; permissions: PermissionSet; stockLocationId: number | null },
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, stockAdded: 0, failed: [] };
  const categoryIds = new Map((await listCategories(db)).map((c) => [norm(c.name), c.id] as const));
  for (const row of rows) {
    try {
      let categoryId: number | null = null;
      if (row.category) {
        const key = norm(row.category);
        let id = categoryIds.get(key);
        if (id === undefined) {
          id = (await createCategory(db, { name: row.category, createdBy: context.userId }, context.permissions)).id;
          categoryIds.set(key, id);
        }
        categoryId = id;
      }
      const created = await createProduct(
        db,
        {
          name: row.name,
          categoryId,
          unit: row.unit ?? undefined,
          purchasePrice: row.purchasePrice,
          salePrice: row.salePrice,
          taxRate: row.taxRate,
          lowStockThreshold: row.lowStockThreshold ?? undefined,
          barcode: row.barcode,
          createdBy: context.userId,
        },
        context.permissions,
      );
      result.created++;
      if (row.stock > 0 && context.stockLocationId != null) {
        try {
          await addManualStockEntry(
            db,
            { variantId: created.defaultVariant.id, locationId: context.stockLocationId, quantity: row.stock, note: t("catalogImport.stockNote"), userId: context.userId },
            context.permissions,
          );
          result.stockAdded++;
        } catch (err) {
          result.failed.push({ line: row.line, name: row.name, message: t("catalogImport.stockFailed", { error: err instanceof Error ? err.message : String(err) }) });
        }
      }
    } catch (err) {
      result.failed.push({ line: row.line, name: row.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** CSV modèle (séparateur « ; », BOM : s'ouvre directement dans Excel). `rows` : nom, catégorie, unité par ligne. */
export function buildCatalogTemplateCsv(rows: Array<{ name: string; category?: string; unit?: string }>): string {
  const header = [
    t("catalogImport.template.name"),
    t("catalogImport.template.category"),
    t("catalogImport.template.unit"),
    t("catalogImport.template.salePrice"),
    t("catalogImport.template.purchasePrice"),
    t("catalogImport.template.stock"),
    t("catalogImport.template.barcode"),
  ];
  const quote = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [header, ...rows.map((r) => [r.name, r.category ?? "", r.unit ?? "", "", "", "", ""])];
  return "﻿" + lines.map((cols) => cols.map(quote).join(";")).join("\r\n") + "\r\n";
}
