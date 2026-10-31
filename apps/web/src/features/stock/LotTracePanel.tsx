import { getLotTrace, type LotTrace } from "@gestion-boutique/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { openWhatsApp } from "../../lib/whatsapp";

interface Props {
  businessName?: string;
  countryCode?: string | null;
}

// Traçabilité d'un numéro de lot : où il est, d'où il vient, à qui il a été vendu —
// pour prévenir les clients en cas de rappel de lot.
export function LotTracePanel({ businessName, countryCode }: Props) {
  const db = useDatabase();
  const { t } = useTranslation();
  const [lot, setLot] = useState("");
  const [trace, setTrace] = useState<LotTrace | null>(null);
  const [searchedLot, setSearchedLot] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    setError(null);
    const wanted = lot.trim();
    if (!wanted) return;
    try {
      setTrace(await getLotTrace(db, wanted));
      setSearchedLot(wanted);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pharmacy.traceFailed"));
    }
  };

  const recall = (customerPhone: string, productName: string) => {
    const message = t("whatsapp.lotRecall", {
      business: businessName ?? t("whatsapp.defaultBusinessName"),
      product: productName,
      lot: searchedLot,
    });
    void openWhatsApp(customerPhone, countryCode, message);
  };

  const totalSold = trace?.sales.reduce((sum, s) => sum + s.quantity, 0) ?? 0;
  const reachable = trace?.sales.filter((s) => s.customerPhone) ?? [];

  return (
    <div style={cardStyle}>
      <strong>{t("pharmacy.traceTitle")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("pharmacy.traceHint")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
        <label style={{ flex: 1, minWidth: 160 }}>
          {t("pharmacy.lotNumber")}
          <input
            style={inputStyle}
            value={lot}
            onChange={(e) => setLot(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSearch();
            }}
          />
        </label>
        <button style={primaryButtonStyle} onClick={handleSearch}>
          {t("pharmacy.traceSearch")}
        </button>
      </div>
      {error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{error}</p>}

      {trace && trace.batches.length === 0 && (
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>{t("pharmacy.traceNotFound", { lot: searchedLot })}</p>
      )}

      {trace && trace.batches.length > 0 && (
        <>
          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("pharmacy.product")}</th>
                  <th style={thStyle}>{t("pharmacy.expiryDate")}</th>
                  <th style={thStyle}>{t("pharmacy.traceRemaining")}</th>
                  <th style={thStyle}>{t("pharmacy.traceOrigin")}</th>
                </tr>
              </thead>
              <tbody>
                {trace.batches.map((b) => (
                  <tr key={b.batch.id}>
                    <td style={tdStyle}>{b.productName}</td>
                    <td style={tdStyle}>{b.batch.expiryDate ?? "—"}</td>
                    <td style={tdStyle}>{b.remaining}</td>
                    <td style={tdStyle}>{[b.supplierName, b.purchaseNumber].filter(Boolean).join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <strong style={{ fontSize: 14 }}>{t("pharmacy.traceSold", { count: totalSold, sales: trace.sales.length })}</strong>
          {trace.sales.length > 0 && (
            <div className="table-scroll">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>{t("pharmacy.traceSale")}</th>
                    <th style={thStyle}>{t("pharmacy.traceDate")}</th>
                    <th style={thStyle}>{t("pharmacy.product")}</th>
                    <th style={thStyle}>{t("pharmacy.quantity")}</th>
                    <th style={thStyle}>{t("pharmacy.traceCustomer")}</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {trace.sales.map((s) => (
                    <tr key={s.saleId}>
                      <td style={tdStyle}>{s.number}</td>
                      <td style={tdStyle}>{s.createdAt.slice(0, 10)}</td>
                      <td style={tdStyle}>{s.productName}</td>
                      <td style={tdStyle}>{s.quantity}</td>
                      <td style={tdStyle}>{s.customerName ?? t("pharmacy.traceAnonymous")}</td>
                      <td style={tdStyle}>
                        {s.customerPhone ? (
                          <button
                            style={{ ...primaryButtonStyle, padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap" }}
                            onClick={() => recall(s.customerPhone!, s.productName)}
                          >
                            {t("pharmacy.traceWarn")}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {trace.sales.length > 0 && (
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
              {t("pharmacy.traceReachable", { reachable: reachable.length, total: trace.sales.length })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
