import { canApprove, decideApprovalRequest, withinApproveLimit, listApprovalRequests, listUnseenDecisions, listUsers, markDecisionsSeen, type ApprovalKind } from "@gestion-boutique/core";
import type { schema } from "@gestion-boutique/database";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { badgeStyle, cardStyle, inputStyle, pageStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { formatAmount } from "../../lib/format";
import { useAuth } from "../auth/useAuth";

type Request = typeof schema.approvalRequests.$inferSelect;

// Demandes d'approbation : celles que ce responsable peut trancher (validation
// ultérieure, sur l'appareil), et le suivi des demandes de chacun.
export function ApprovalsPage() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [requests, setRequests] = useState<Request[]>([]);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Décisions rendues depuis la dernière visite (mises en évidence, puis marquées vues).
  const [unseenIds, setUnseenIds] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchNote, setBatchNote] = useState<string | null>(null);

  const perms = user?.permissions ?? {};
  const refresh = useCallback(async () => {
    const [rows, users] = await Promise.all([listApprovalRequests(db, { limit: 200 }), listUsers(db)]);
    setRequests(rows);
    setNames(new Map(users.map((u) => [u.id, u.fullName] as const)));
  }, [db]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const unseen = await listUnseenDecisions(db, user.id);
      setUnseenIds(new Set(unseen.map((r) => r.id)));
      if (unseen.length > 0) await markDecisionsSeen(db, user.id);
    })();
  }, [db, user]);

  const nameOf = (id: number | null) => (id == null ? "—" : (names.get(id) ?? `#${id}`));
  const toDecide = requests.filter((r) => r.status === "pending" && canApprove(perms, r.kind as ApprovalKind));
  const mine = requests.filter((r) => r.requestedBy === user?.id);
  const history = requests.filter((r) => r.status !== "pending" && (canApprove(perms, r.kind as ApprovalKind) || r.requestedBy === user?.id)).slice(0, 40);

  const decide = async (request: Request, approve: boolean) => {
    if (!user) return;
    setError(null);
    setBusyId(request.id);
    try {
      await decideApprovalRequest(db, { requestId: request.id, approve, note: approve ? undefined : note, userId: user.id }, user.permissions);
      setRejectingId(null);
      setNote("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  // Les demandes que cette personne peut trancher tout de suite (droit, plafond, pas les siennes).
  const decidable = (r: Request) => withinApproveLimit(user?.limitApprove, r.kind as ApprovalKind, r.amount) && r.requestedBy !== user?.id;
  const toggleSelected = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const approveSelected = async () => {
    if (!user) return;
    setError(null);
    setBatchNote(null);
    let done = 0;
    const failures: string[] = [];
    for (const id of selected) {
      const request = requests.find((r) => r.id === id);
      if (!request) continue;
      try {
        await decideApprovalRequest(db, { requestId: id, approve: true, userId: user.id }, user.permissions);
        done++;
      } catch (err) {
        failures.push(`${request.summary} : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setSelected(new Set());
    setBatchNote(t("approvalRequests.batchDone", { count: done }) + (failures.length > 0 ? " " + failures.join(" | ") : ""));
    await refresh();
  };

  const statusBadge = (r: Request) => (
    <span style={badgeStyle(r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warning")}>{t(`approvalRequests.status.${r.status}`)}</span>
  );

  return (
    <main style={pageStyle}>
      <h1>{t("approvalRequests.title")}</h1>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("approvalRequests.hint")}</p>
      {error && <p style={{ color: "var(--color-danger)", margin: 0 }}>{error}</p>}

      {toDecide.length > 0 || requests.length === 0 || perms.approve_actions ? (
        <div style={{ ...cardStyle, borderColor: toDecide.length > 0 ? "var(--color-warning)" : undefined }}>
          <strong>{t("approvalRequests.pendingTitle", { count: toDecide.length })}</strong>
          {toDecide.length === 0 ? (
            <p style={{ margin: 0, color: "var(--color-text-muted)" }}>{t("approvalRequests.nonePending")}</p>
          ) : (
            <>
            {toDecide.filter(decidable).length > 1 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button
                  style={{ background: "transparent", border: "none", color: "var(--color-accent)", cursor: "pointer", padding: 0, fontSize: 13 }}
                  onClick={() => setSelected(new Set(toDecide.filter(decidable).map((r) => r.id)))}
                >
                  {t("approvalRequests.selectAll")}
                </button>
                {selected.size > 0 && (
                  <button style={{ ...primaryButtonStyle, padding: "6px 12px" }} onClick={approveSelected}>
                    {t("approvalRequests.approveSelected", { count: selected.size })}
                  </button>
                )}
              </div>
            )}
            {batchNote && <p style={{ margin: 0, fontSize: 13 }}>{batchNote}</p>}
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
              {toDecide.map((r) => (
                <li key={r.id} style={{ borderBottom: "1px dashed var(--color-rule-strong)", paddingBottom: 12 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    {decidable(r) && toDecide.filter(decidable).length > 1 && (
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelected(r.id)} aria-label={t("approvalRequests.select")} />
                    )}
                    <span style={badgeStyle("info")}>{t(`approvalRequests.kinds.${r.kind}`)}</span>
                    <strong>{r.summary}</strong>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--color-text-muted)", margin: "4px 0" }}>
                    {t("approvalRequests.by", { name: nameOf(r.requestedBy), date: r.createdAt.slice(0, 16) })} —{" "}
                    {r.kind === "stock" ? t("approvalRequests.effectNow") : t("approvalRequests.blocked")}
                  </div>
                  {!withinApproveLimit(user?.limitApprove, r.kind as ApprovalKind, r.amount) ? (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--color-warning)" }}>{t("approvalRequests.overLimit")}</p>
                  ) : r.requestedBy === user?.id ? (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-muted)" }}>{t("approvalRequests.errors.selfDecision")}</p>
                  ) : rejectingId === r.id ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
                      <label style={{ flex: "1 1 240px" }}>
                        {t("approvalRequests.reason")}
                        <input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} />
                      </label>
                      <button style={{ ...primaryButtonStyle, background: "var(--color-danger)" }} disabled={!note.trim() || busyId === r.id} onClick={() => decide(r, false)}>
                        {t("approvalRequests.confirmReject")}
                      </button>
                      <button style={{ ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)" }} onClick={() => setRejectingId(null)}>
                        {t("approvalRequests.cancel")}
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button style={primaryButtonStyle} disabled={busyId === r.id} onClick={() => decide(r, true)}>
                        {t("approvalRequests.approve")}
                      </button>
                      <button
                        style={{ ...primaryButtonStyle, background: "transparent", border: "1px solid var(--color-danger)", color: "var(--color-danger)" }}
                        onClick={() => {
                          setRejectingId(r.id);
                          setNote("");
                        }}
                      >
                        {t("approvalRequests.reject")}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            </>
          )}
        </div>
      ) : null}

      <div style={cardStyle}>
        <strong>{t("approvalRequests.myTitle")}</strong>
        {mine.length === 0 ? (
          <p style={{ margin: 0, color: "var(--color-text-muted)" }}>{t("approvalRequests.none")}</p>
        ) : (
          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("approvalRequests.col.date")}</th>
                  <th style={thStyle}>{t("approvalRequests.col.detail")}</th>
                  <th style={thStyle}>{t("approvalRequests.col.amount")}</th>
                  <th style={thStyle}>{t("approvalRequests.col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((r) => (
                  <tr key={r.id}>
                    <td style={tdStyle}>{r.createdAt.slice(0, 16)}</td>
                    <td style={tdStyle}>
                      {unseenIds.has(r.id) && <span style={{ ...badgeStyle("info"), marginRight: 6 }}>{t("approvalRequests.new")}</span>}
                      {r.summary}
                      {r.decisionNote ? <em style={{ display: "block", color: "var(--color-text-muted)" }}>{r.decisionNote}</em> : null}
                    </td>
                    <td style={tdStyle}>{r.kind === "points" ? r.amount : formatAmount(r.amount)}</td>
                    <td style={tdStyle}>{statusBadge(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div style={cardStyle}>
          <strong>{t("approvalRequests.historyTitle")}</strong>
          <div className="table-scroll">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t("approvalRequests.col.date")}</th>
                  <th style={thStyle}>{t("approvalRequests.col.detail")}</th>
                  <th style={thStyle}>{t("approvalRequests.col.requestedBy")}</th>
                  <th style={thStyle}>{t("approvalRequests.col.decidedBy")}</th>
                  <th style={thStyle}>{t("approvalRequests.col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td style={tdStyle}>{(r.decidedAt ?? r.createdAt).slice(0, 16)}</td>
                    <td style={tdStyle}>
                      {r.summary}
                      {r.decisionNote ? <em style={{ display: "block", color: "var(--color-text-muted)" }}>{r.decisionNote}</em> : null}
                    </td>
                    <td style={tdStyle}>{nameOf(r.requestedBy)}</td>
                    <td style={tdStyle}>{nameOf(r.decidedBy)}</td>
                    <td style={tdStyle}>{statusBadge(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
