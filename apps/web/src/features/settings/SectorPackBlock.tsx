import { buildCatalogTemplateCsv, installStarterCategories } from "@gestion-boutique/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { primaryButtonStyle } from "../../components/sharedStyles";
import { saveGeneratedFile } from "../../lib/saveFile";
import { useAuth } from "../auth/useAuth";

// Secteurs qui ont un pack de démarrage générique (la pharmacie a le sien, avec fiche médicament).
export const GENERIC_PACK_SECTORS = ["boutique", "boulangerie", "quincaillerie", "restaurant"] as const;
export type GenericPackSector = (typeof GENERIC_PACK_SECTORS)[number];

export function hasGenericPack(sector: string): sector is GenericPackSector {
  return (GENERIC_PACK_SECTORS as readonly string[]).includes(sector);
}

// Pack de démarrage d'un secteur : les catégories habituelles, et un modèle de catalogue prérempli (noms, catégories
// et unités — jamais de prix ni de code-barres inventés) à compléter dans un tableur puis importer depuis Produits.
export function SectorPackBlock({ sector }: { sector: GenericPackSector }) {
  const { t } = useTranslation();
  const db = useDatabase();
  const { user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);

  const categories = () => {
    const raw = t(`sectorPacks.${sector}.categories`, { returnObjects: true }) as unknown;
    return Array.isArray(raw) ? (raw as string[]) : [];
  };
  const products = () => {
    const raw = t(`sectorPacks.${sector}.products`, { returnObjects: true }) as unknown;
    return Array.isArray(raw) ? (raw as Array<{ name: string; category?: string; unit?: string }>) : [];
  };

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: 12, display: "grid", gap: 8 }}>
      <strong style={{ fontSize: 14 }}>{t("sectorPackUi.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("sectorPackUi.hint")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={async () => {
            setMessage(null);
            try {
              const created = await installStarterCategories(db, categories(), user?.id, user?.permissions ?? {});
              setMessage(created.length > 0 ? t("sectorPackUi.categoriesDone", { count: created.length }) : t("sectorPackUi.categoriesNone"));
            } catch (err) {
              setMessage(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          {t("sectorPackUi.installCategories")}
        </button>
        <button
          type="button"
          style={{ ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
          onClick={async () => {
            const blob = new Blob([buildCatalogTemplateCsv(products())], { type: "text/csv;charset=utf-8" });
            await saveGeneratedFile(blob, `modele-catalogue-${sector}.csv`);
          }}
        >
          {t("sectorPackUi.downloadTemplate")}
        </button>
      </div>
      {message && <p style={{ fontSize: 13, margin: 0 }}>{message}</p>}
    </div>
  );
}
