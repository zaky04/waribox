import { MIGRATIONS } from "@gestion-boutique/database";
import { sql } from "drizzle-orm";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDevice, releaseDevices } from "./testDb";

afterAll(releaseDevices);

// Garde-fous contre les petites erreurs qui ne se voient qu'une fois l'application
// livrée : migration mal numérotée, texte traduit manquant dans une langue.

describe("migrations de base de données", () => {
  it("ont des identifiants uniques et strictement croissants", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(1);
    // Pas de trou : un numéro sauté est presque toujours une migration oubliée.
    expect(ids).toEqual(ids.map((_, i) => i + 1));
  });

  it("s'appliquent toutes sur une base neuve et sont toutes enregistrées", async () => {
    const device = await createDevice("migrations");
    const rows = (await device.db!.all(sql`SELECT id FROM __migrations`)) as Array<{ id: number } | number[]>;
    const applied = rows.map((r) => Number(Array.isArray(r) ? r[0] : r.id)).sort((a, b) => a - b);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
  });
});

const root = resolve(__dirname, "../../../..");
const locales = (lang: string) => JSON.parse(readFileSync(join(root, "packages/i18n/src/locales", `${lang}.json`), "utf-8")) as Record<string, unknown>;

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "target" || name === "gen") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("traductions FR / EN", () => {
  const fr = flatten(locales("fr"));
  const en = flatten(locales("en"));
  // i18next ajoute les suffixes de pluriel (_one, _other…) : on compare sans eux.
  const base = (keys: string[]) => new Set(keys.map((k) => k.replace(/_(zero|one|two|few|many|other)$/, "")));

  it("ont exactement les mêmes clés dans les deux langues", () => {
    const frSet = base(fr);
    const enSet = base(en);
    expect([...frSet].filter((k) => !enSet.has(k))).toEqual([]);
    expect([...enSet].filter((k) => !frSet.has(k))).toEqual([]);
  });

  it("couvrent chaque clé littérale t(\"…\") utilisée dans le code", () => {
    const known = base(fr);
    const missing = new Set<string>();
    for (const dir of ["apps/web/src", "packages/core/src", "packages/printer/src", "packages/reports/src", "packages/sync/src"]) {
      for (const file of sourceFiles(join(root, dir))) {
        const text = readFileSync(file, "utf-8");
        for (const m of text.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)) {
          if (!known.has(m[1]!)) missing.add(`${m[1]}  (${file.replace(root, "").replace(/\\/g, "/")})`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
