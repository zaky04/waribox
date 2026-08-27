import {
  deleteExpenseAccountMapping,
  getSyscohadaAccountSettings,
  listExpenseAccountMappings,
  updateSyscohadaAccounts,
  upsertExpenseAccountMapping,
  type SyscohadaAccountSettings,
  type SyscohadaExpenseAccountMapping,
} from "@gestion-boutique/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { inputStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { useAuth } from "../auth/useAuth";

const secondaryButtonStyle = {
  ...primaryButtonStyle,
  background: "transparent",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
  padding: "6px 12px",
  fontSize: 13,
};

export function SyscohadaAccountsSection() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const ROLE_FIELDS: { key: keyof Omit<SyscohadaAccountSettings, "defaultExpenseAccount">; label: string }[] = [
    { key: "clients", label: t("syscohadaSection.roles.clients") },
    { key: "fournisseurs", label: t("syscohadaSection.roles.fournisseurs") },
    { key: "tvaVentes", label: t("syscohadaSection.roles.tvaVentes") },
    { key: "tvaServices", label: t("syscohadaSection.roles.tvaServices") },
    { key: "tvaAchats", label: t("syscohadaSection.roles.tvaAchats") },
    { key: "banque", label: t("syscohadaSection.roles.banque") },
    { key: "caisse", label: t("syscohadaSection.roles.caisse") },
    { key: "mobileMoney", label: t("syscohadaSection.roles.mobileMoney") },
    { key: "achats", label: t("syscohadaSection.roles.achats") },
    { key: "ventes", label: t("syscohadaSection.roles.ventes") },
    { key: "services", label: t("syscohadaSection.roles.services") },
  ];

  const [codes, setCodes] = useState<Record<string, string>>({});
  const [defaultExpenseCode, setDefaultExpenseCode] = useState("628");
  const [defaultExpenseLabel, setDefaultExpenseLabel] = useState("Autres charges externes");
  const [savingAccounts, setSavingAccounts] = useState(false);
  const [accountsSaved, setAccountsSaved] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [mappings, setMappings] = useState<SyscohadaExpenseAccountMapping[]>([]);
  const [drafts, setDrafts] = useState<Record<number, { accountCode: string; accountLabel: string }>>({});
  const [newCategory, setNewCategory] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [mappingError, setMappingError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [accounts, mappingRows] = await Promise.all([
      getSyscohadaAccountSettings(db),
      listExpenseAccountMappings(db),
    ]);
    const nextCodes: Record<string, string> = {};
    for (const field of ROLE_FIELDS) nextCodes[field.key] = accounts[field.key].code;
    setCodes(nextCodes);
    setDefaultExpenseCode(accounts.defaultExpenseAccount.code);
    setDefaultExpenseLabel(accounts.defaultExpenseAccount.label);
    setMappings(mappingRows);
    setDrafts(
      Object.fromEntries(mappingRows.map((m) => [m.id, { accountCode: m.accountCode, accountLabel: m.accountLabel }])),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSaveAccounts = async () => {
    setAccountsError(null);
    setAccountsSaved(false);
    if (Object.values(codes).some((c) => !c.trim()) || !defaultExpenseCode.trim() || !defaultExpenseLabel.trim()) {
      setAccountsError(t("syscohadaSection.errorAllRequired"));
      return;
    }
    setSavingAccounts(true);
    try {
      await updateSyscohadaAccounts(
        db,
        {
          syscohadaAccountClients: codes.clients?.trim(),
          syscohadaAccountFournisseurs: codes.fournisseurs?.trim(),
          syscohadaAccountTvaVentes: codes.tvaVentes?.trim(),
          syscohadaAccountTvaServices: codes.tvaServices?.trim(),
          syscohadaAccountTvaAchats: codes.tvaAchats?.trim(),
          syscohadaAccountBanque: codes.banque?.trim(),
          syscohadaAccountCaisse: codes.caisse?.trim(),
          syscohadaAccountMobileMoney: codes.mobileMoney?.trim(),
          syscohadaAccountAchats: codes.achats?.trim(),
          syscohadaAccountVentes: codes.ventes?.trim(),
          syscohadaAccountServices: codes.services?.trim(),
          syscohadaDefaultExpenseAccountCode: defaultExpenseCode.trim(),
          syscohadaDefaultExpenseAccountLabel: defaultExpenseLabel.trim(),
        },
        user?.permissions ?? {},
      );
      setAccountsSaved(true);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : t("syscohadaSection.errorSaveAccounts"));
    } finally {
      setSavingAccounts(false);
    }
  };

  const handleSaveMapping = async (mapping: SyscohadaExpenseAccountMapping) => {
    const draft = drafts[mapping.id];
    if (!draft || !draft.accountCode.trim() || !draft.accountLabel.trim()) return;
    await upsertExpenseAccountMapping(
      db,
      { category: mapping.category, accountCode: draft.accountCode.trim(), accountLabel: draft.accountLabel.trim() },
      user?.permissions ?? {},
    );
    await refresh();
  };

  const handleDeleteMapping = async (mapping: SyscohadaExpenseAccountMapping) => {
    await deleteExpenseAccountMapping(db, mapping.id, user?.permissions ?? {});
    await refresh();
  };

  const handleAddMapping = async () => {
    setMappingError(null);
    if (!newCategory.trim() || !newCode.trim() || !newLabel.trim()) {
      setMappingError(t("syscohadaSection.errorMappingRequired"));
      return;
    }
    if (mappings.some((m) => m.category.toLowerCase() === newCategory.trim().toLowerCase())) {
      setMappingError(t("syscohadaSection.errorMappingDuplicate"));
      return;
    }
    await upsertExpenseAccountMapping(
      db,
      { category: newCategory.trim(), accountCode: newCode.trim(), accountLabel: newLabel.trim() },
      user?.permissions ?? {},
    );
    setNewCategory("");
    setNewCode("");
    setNewLabel("");
    await refresh();
  };

  return (
    <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12, marginTop: 4 }}>
      <strong style={{ fontSize: 14 }}>{t("syscohadaSection.heading")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "4px 0 12px" }}>
        {t("syscohadaSection.hint")}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {ROLE_FIELDS.map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              style={inputStyle}
              value={codes[field.key] ?? ""}
              onChange={(e) => setCodes({ ...codes, [field.key]: e.target.value })}
            />
          </label>
        ))}
      </div>

      <strong style={{ fontSize: 14, marginTop: 16, display: "block" }}>
        {t("syscohadaSection.defaultExpenseHeading")}
      </strong>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label>
          {t("syscohadaSection.accountCode")}
          <input style={inputStyle} value={defaultExpenseCode} onChange={(e) => setDefaultExpenseCode(e.target.value)} />
        </label>
        <label>
          {t("syscohadaSection.accountLabel")}
          <input style={inputStyle} value={defaultExpenseLabel} onChange={(e) => setDefaultExpenseLabel(e.target.value)} />
        </label>
      </div>

      {accountsError && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{accountsError}</p>}
      {accountsSaved && <p style={{ color: "var(--color-success)", fontSize: 13 }}>{t("syscohadaSection.saved")}</p>}
      <button style={{ ...primaryButtonStyle, marginTop: 8 }} onClick={handleSaveAccounts} disabled={savingAccounts}>
        {savingAccounts ? t("syscohadaSection.saving") : t("syscohadaSection.saveAccounts")}
      </button>

      <strong style={{ fontSize: 14, marginTop: 24, display: "block" }}>
        {t("syscohadaSection.mappingsHeading")}
      </strong>
      <div className="table-scroll" style={{ marginTop: 8 }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>{t("syscohadaSection.category")}</th>
            <th style={thStyle}>{t("syscohadaSection.account")}</th>
            <th style={thStyle}>{t("syscohadaSection.label")}</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((m) => (
            <tr key={m.id}>
              <td style={tdStyle}>{m.category}</td>
              <td style={tdStyle}>
                <input
                  style={{ ...inputStyle, width: 90 }}
                  value={drafts[m.id]?.accountCode ?? ""}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [m.id]: { ...drafts[m.id], accountCode: e.target.value, accountLabel: drafts[m.id]?.accountLabel ?? "" } })
                  }
                />
              </td>
              <td style={tdStyle}>
                <input
                  style={inputStyle}
                  value={drafts[m.id]?.accountLabel ?? ""}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [m.id]: { ...drafts[m.id], accountLabel: e.target.value, accountCode: drafts[m.id]?.accountCode ?? "" } })
                  }
                />
              </td>
              <td style={tdStyle}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <button style={secondaryButtonStyle} onClick={() => handleSaveMapping(m)}>
                    {t("syscohadaSection.save")}
                  </button>
                  <button style={secondaryButtonStyle} onClick={() => handleDeleteMapping(m)}>
                    {t("syscohadaSection.delete")}
                  </button>
                </div>
              </td>
            </tr>
          ))}
          <tr>
            <td style={tdStyle}>
              <input
                style={inputStyle}
                placeholder={t("syscohadaSection.newCategoryPlaceholder")}
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
              />
            </td>
            <td style={tdStyle}>
              <input
                style={{ ...inputStyle, width: 90 }}
                placeholder={t("syscohadaSection.newCodePlaceholder")}
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
              />
            </td>
            <td style={tdStyle}>
              <input
                style={inputStyle}
                placeholder={t("syscohadaSection.newLabelPlaceholder")}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </td>
            <td style={tdStyle}>
              <button style={secondaryButtonStyle} onClick={handleAddMapping}>
                {t("syscohadaSection.addMapping")}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      {mappingError && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{mappingError}</p>}
      <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("syscohadaSection.footerHint")}</p>
    </div>
  );
}
