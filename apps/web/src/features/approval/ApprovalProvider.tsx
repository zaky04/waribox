import {
  ApprovalDeniedError,
  ApprovalRequiredError,
  listApprovers,
  type ApprovalInput,
} from "@gestion-boutique/core";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { cardStyle, inputStyle, primaryButtonStyle } from "../../components/sharedStyles";

// Approbation d'un responsable pour les actions qui dépassent un plafond
// (remboursement, mouvement de stock, vente à crédit — voir ApprovalService).
// `run(action)` exécute l'action ; si le service répond "approbation requise",
// une fenêtre demande le responsable et son code PIN, puis relance l'action
// avec cette approbation — et la redemande si le code est refusé.
interface ApprovalContextValue {
  run: <T>(action: (approval?: ApprovalInput) => Promise<T>) => Promise<T>;
}

const ApprovalContext = createContext<ApprovalContextValue | null>(null);

export function useApproval(): ApprovalContextValue {
  const ctx = useContext(ApprovalContext);
  if (!ctx) throw new Error("useApproval() doit être utilisé à l'intérieur de <ApprovalProvider>");
  return ctx;
}

interface PromptState {
  info: ApprovalRequiredError;
  error: string | null;
  approvers: { id: number; fullName: string }[];
}

export function ApprovalProvider({ children }: { children: ReactNode }) {
  const db = useDatabase();
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [approverId, setApproverId] = useState("");
  const [pin, setPin] = useState("");
  const resolverRef = useRef<((value: ApprovalInput | null) => void) | null>(null);

  const ask = useCallback(
    async (info: ApprovalRequiredError, error: string | null): Promise<ApprovalInput | null> => {
      const approvers = await listApprovers(db);
      setApproverId(approvers[0] ? String(approvers[0].id) : "");
      setPin("");
      setPrompt({ info, error, approvers });
      return new Promise((resolve) => {
        resolverRef.current = resolve;
      });
    },
    [db],
  );

  const finish = (value: ApprovalInput | null) => {
    setPrompt(null);
    resolverRef.current?.(value);
    resolverRef.current = null;
  };

  const run = useCallback(
    async <T,>(action: (approval?: ApprovalInput) => Promise<T>): Promise<T> => {
      let approval: ApprovalInput | undefined;
      let info: ApprovalRequiredError | null = null;
      let deniedMessage: string | null = null;
      for (;;) {
        try {
          return await action(approval);
        } catch (err) {
          if (err instanceof ApprovalRequiredError) {
            info = err;
            deniedMessage = null;
          } else if (err instanceof ApprovalDeniedError && info) {
            deniedMessage = err.message;
          } else {
            throw err;
          }
          const next = await ask(info, deniedMessage);
          if (!next) throw new Error(t("approval.cancelled"));
          approval = next;
        }
      }
    },
    [ask, t],
  );

  return (
    <ApprovalContext.Provider value={{ run }}>
      {children}
      {prompt && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 1000,
          }}
        >
          <form
            style={{ ...cardStyle, width: "min(420px, 100%)", maxHeight: "85vh", overflowY: "auto" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (approverId && pin) finish({ approverId: Number(approverId), pin });
            }}
          >
            <strong>{t("approval.title")}</strong>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{prompt.info.message}</p>
            {prompt.approvers.length === 0 ? (
              <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{t("approval.noApprover")}</p>
            ) : (
              <>
                <label>
                  {t("approval.approver")}
                  <select style={inputStyle} value={approverId} onChange={(e) => setApproverId(e.target.value)}>
                    {prompt.approvers.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.fullName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("approval.pin")}
                  <input
                    style={inputStyle}
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    autoFocus
                  />
                </label>
              </>
            )}
            {prompt.error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{prompt.error}</p>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button style={primaryButtonStyle} type="submit" disabled={!approverId || !pin}>
                {t("approval.approve")}
              </button>
              <button
                type="button"
                style={{
                  background: "transparent",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  padding: "10px 16px",
                  cursor: "pointer",
                }}
                onClick={() => finish(null)}
              >
                {t("approval.cancel")}
              </button>
            </div>
          </form>
        </div>
      )}
    </ApprovalContext.Provider>
  );
}
