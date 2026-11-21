import {
  buildCatalogTemplateCsv,
  listLocations,
  loadExistingCatalogKeys,
  parseCsv,
  planCatalogImport,
  runCatalogImport,
  type CatalogPlan,
  type ImportResult,
} from "@gestion-boutique/core";
import { readXlsxFirstSheet } from "@gestion-boutique/reports";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { formatAmount } from "../../lib/format";
import { saveGeneratedFile } from "../../lib/saveFile";
import { useAuth } from "../auth/useAuth";

// Un CSV enregistré par Excel en français est souvent en ANSI (Windows-1252), pas en UTF-8 : on essaie UTF-8 strict,
// puis on retombe sur Windows-1252 plutôt que d'afficher des « Ã© ».
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const secondaryButton = { ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)" } as const;

// Import d'un catalogue depuis un tableur (voir packages/core/src/import/catalogImport.ts) : lecture, aperçu
// de ce qui sera créé / ignoré / refusé, puis import.
export function CatalogImportPanel({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<CatalogPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMessage(t("catalogImport.reading"));
    setResult(null);
    setPlan(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const table = /\.xlsx$/i.test(file.name) ? await readXlsxFirstSheet(bytes) : parseCsv(decodeText(bytes));
      setPlan(planCatalogImport(table, await loadExistingCatalogKeys(db)));
      setFileName(file.name);
      setMessage(null);
    } catch (err) {
      setMessage(t("catalogImport.readFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!plan || !user) return;
    setBusy(true);
    try {
      const locations = await listLocations(db, currentStoreId ?? undefined);
      const surface = locations.find((l) => l.type === "surface_vente" || l.type.startsWith("surface_vente#"));
      const outcome = await runCatalogImport(db, plan.toCreate, { userId: user.id, permissions: user.permissions, stockLocationId: surface?.id ?? null });
      setResult(outcome);
      setPlan(null);
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async () => {
    const blob = new Blob([buildCatalogTemplateCsv([])], { type: "text/csv;charset=utf-8" });
    await saveGeneratedFile(blob, "modele-catalogue.csv");
  };

  const problems = plan ? [...plan.errors.map((p) => ({ ...p, kind: "error" as const })), ...plan.duplicates.map((p) => ({ ...p, kind: "dup" as const }))].sort((a, b) => a.line - b.line) : [];

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{t("catalogImport.title")}</strong>
        <button style={secondaryButton} onClick={onClose}>
          ✕
        </button>
      </div>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("catalogImport.hint")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button style={primaryButtonStyle} disabled={busy} onClick={() => fileRef.current?.click()}>
          {t("catalogImport.choose")}
        </button>
        <button style={secondaryButton} onClick={() => void downloadTemplate()}>
          {t("catalogImport.templateDownload")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style={{ display: "none" }}
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {message && <p style={{ margin: 0, color: "var(--color-danger)" }}>{message}</p>}

      {plan?.headerError && <p style={{ margin: 0, color: "var(--color-danger)", fontWeight: 600 }}>{plan.headerError}</p>}
      {plan && !plan.headerError && (
        <>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {fileName} — {t("catalogImport.summary", { create: plan.toCreate.length, dup: plan.duplicates.length, err: plan.errors.length })}
          </p>
          <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: 12.5 }}>{t("catalogImport.recognized", { columns: plan.recognized.join(", ") })}</p>
          {plan.toCreate.length > 0 && (
            <div className="table-scroll">
              <table style={tableStyle}>
                <tbody>
                  {plan.toCreate.slice(0, 6).map((r) => (
                    <tr key={r.line}>
                      <td style={tdStyle}>{r.name}</td>
                      <td style={tdStyle}>{r.category ?? "—"}</td>
                      <td style={tdStyle}>{formatAmount(r.salePrice)}</td>
                      <td style={tdStyle}>{r.stock > 0 ? `×${r.stock}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {problems.length > 0 && (
            <div>
              <strong style={{ fontSize: 13 }}>{t("catalogImport.problems")}</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, maxHeight: 160, overflowY: "auto", fontSize: 13 }}>
                {problems.slice(0, 60).map((p) => (
                  <li key={`${p.kind}-${p.line}`} style={{ color: p.kind === "error" ? "var(--color-danger)" : "var(--color-text-muted)" }}>
                    {t("catalogImport.line", { line: p.line })} — {p.name || "—"} : {p.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <button style={primaryButtonStyle} disabled={busy || plan.toCreate.length === 0} onClick={() => void runImport()}>
              {t("catalogImport.confirm", { count: plan.toCreate.length })}
            </button>
          </div>
        </>
      )}

      {result && (
        <div>
          <p style={{ margin: 0, color: "var(--color-success)", fontWeight: 600 }}>{t("catalogImport.done", { created: result.created, stock: result.stockAdded })}</p>
          {result.failed.length > 0 && (
            <>
              <p style={{ margin: "6px 0 0", color: "var(--color-danger)" }}>{t("catalogImport.failedSome", { count: result.failed.length })}</p>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
                {result.failed.slice(0, 30).map((f) => (
                  <li key={f.line}>
                    {t("catalogImport.line", { line: f.line })} — {f.name} : {f.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
