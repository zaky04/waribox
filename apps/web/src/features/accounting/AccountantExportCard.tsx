import { buildAccountantExport, hasPermission } from "@gestion-boutique/core";
import { buildAccountantWorkbook } from "@gestion-boutique/reports";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";
import { saveGeneratedFile } from "../../lib/saveFile";
import { useAuth } from "../auth/useAuth";

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Par défaut : le mois dernier en entier — la période que l'expert-comptable réclame le plus souvent.
function lastMonth(): { from: string; to: string } {
  const now = new Date();
  return { from: isoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: isoDay(new Date(now.getFullYear(), now.getMonth(), 0)) };
}

export function AccountantExportCard() {
  const { t } = useTranslation();
  const db = useDatabase();
  const { user, currentStoreId } = useAuth();
  const initial = lastMonth();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasPermission(user?.permissions ?? {}, "export_reports")) return null;

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await buildAccountantExport(db, { from, to }, currentStoreId ?? undefined);
      await saveGeneratedFile(buildAccountantWorkbook(data.sheets), `dossier-comptable-${from}-${to}.xlsx`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...cardStyle, marginTop: 16 }}>
      <strong>{t("accountantExport.title")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("accountantExport.hint")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <label>
          {t("accounting.from")}
          <input style={inputStyle} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t("accounting.to")}
          <input style={inputStyle} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button style={primaryButtonStyle} disabled={busy || !from || !to || from > to} onClick={() => void download()}>
          {t("accountantExport.button")}
        </button>
      </div>
      {error && <p style={{ color: "var(--color-danger)", margin: 0 }}>{error}</p>}
    </div>
  );
}
