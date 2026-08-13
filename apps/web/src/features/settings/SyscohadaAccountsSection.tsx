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

const ROLE_FIELDS: { key: keyof Omit<SyscohadaAccountSettings, "defaultExpenseAccount">; label: string }[] = [
  { key: "clients", label: "Clients" },
  { key: "fournisseurs", label: "Fournisseurs" },
  { key: "tvaVentes", label: "TVA facturée — ventes de marchandises" },
  { key: "tvaServices", label: "TVA facturée — prestations de services" },
  { key: "tvaAchats", label: "TVA récupérable — achats" },
  { key: "banque", label: "Banques" },
  { key: "caisse", label: "Caisse" },
  { key: "mobileMoney", label: "Mobile Money" },
  { key: "achats", label: "Achats de marchandises" },
  { key: "ventes", label: "Ventes de marchandises" },
  { key: "services", label: "Services vendus" },
];

export function SyscohadaAccountsSection() {
  const db = useDatabase();
  const { user } = useAuth();

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
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSaveAccounts = async () => {
    setAccountsError(null);
    setAccountsSaved(false);
    if (Object.values(codes).some((c) => !c.trim()) || !defaultExpenseCode.trim() || !defaultExpenseLabel.trim()) {
      setAccountsError("Tous les numéros de compte sont requis.");
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
      setAccountsError(err instanceof Error ? err.message : "Impossible d'enregistrer les comptes.");
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
      setMappingError("Catégorie, numéro de compte et intitulé sont requis.");
      return;
    }
    if (mappings.some((m) => m.category.toLowerCase() === newCategory.trim().toLowerCase())) {
      setMappingError("Cette catégorie a déjà un compte associé — modifie-le directement dans la liste.");
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
      <strong style={{ fontSize: 14 }}>Numéros de compte</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "4px 0 12px" }}>
        Modifiables à tout moment — le référentiel SYSCOHADA est parfois révisé par l&apos;OHADA, sans que le
        rôle de chaque compte (Clients, Ventes, Caisse...) ne change.
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
        Compte de charge par défaut (catégorie non mappée)
      </strong>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label>
          Numéro de compte
          <input style={inputStyle} value={defaultExpenseCode} onChange={(e) => setDefaultExpenseCode(e.target.value)} />
        </label>
        <label>
          Intitulé
          <input style={inputStyle} value={defaultExpenseLabel} onChange={(e) => setDefaultExpenseLabel(e.target.value)} />
        </label>
      </div>

      {accountsError && <p style={{ color: "#f87171", fontSize: 13 }}>{accountsError}</p>}
      {accountsSaved && <p style={{ color: "#86efac", fontSize: 13 }}>Comptes enregistrés.</p>}
      <button style={{ ...primaryButtonStyle, marginTop: 8 }} onClick={handleSaveAccounts} disabled={savingAccounts}>
        {savingAccounts ? "Enregistrement..." : "Enregistrer les comptes"}
      </button>

      <strong style={{ fontSize: 14, marginTop: 24, display: "block" }}>
        Comptes de charge par catégorie de dépense
      </strong>
      <table style={{ ...tableStyle, marginTop: 8 }}>
        <thead>
          <tr>
            <th style={thStyle}>Catégorie</th>
            <th style={thStyle}>Compte</th>
            <th style={thStyle}>Intitulé</th>
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
                <div style={{ display: "flex", gap: 6 }}>
                  <button style={secondaryButtonStyle} onClick={() => handleSaveMapping(m)}>
                    Enregistrer
                  </button>
                  <button style={secondaryButtonStyle} onClick={() => handleDeleteMapping(m)}>
                    Supprimer
                  </button>
                </div>
              </td>
            </tr>
          ))}
          <tr>
            <td style={tdStyle}>
              <input
                style={inputStyle}
                placeholder="Nouvelle catégorie"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
              />
            </td>
            <td style={tdStyle}>
              <input
                style={{ ...inputStyle, width: 90 }}
                placeholder="Compte"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
              />
            </td>
            <td style={tdStyle}>
              <input
                style={inputStyle}
                placeholder="Intitulé"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </td>
            <td style={tdStyle}>
              <button style={secondaryButtonStyle} onClick={handleAddMapping}>
                + Ajouter
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {mappingError && <p style={{ color: "#f87171", fontSize: 13 }}>{mappingError}</p>}
      <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
        Toute catégorie de dépense saisie sans compte associé ici retombe automatiquement sur le compte de
        charge par défaut ci-dessus.
      </p>
    </div>
  );
}
