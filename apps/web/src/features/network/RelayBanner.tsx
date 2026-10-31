import { useTranslation } from "react-i18next";
import { useDeviceRoleStore } from "../../stores/deviceRole";
import { useNetwork } from "./NetworkProvider";

// Bandeau affiché sur un appareil relié : où il en est avec le Maître, ce qu'il ne peut pas faire ici,
// et ce qui n'est pas encore partagé. Sans lui, un caissier ne saurait pas pourquoi « créer un produit »
// est refusé, ni que ses encaissements de créances restent sur sa tablette.
export function RelayBanner() {
  const { t } = useTranslation();
  const role = useDeviceRoleStore((s) => s.role);
  const { worker } = useNetwork();
  if (role !== "worker") return null;

  const connected = worker.status === "connected";
  return (
    <div
      role="status"
      style={{
        padding: "8px clamp(12px, 4vw, 24px)",
        background: "var(--color-bg-elevated)",
        borderBottom: "1px solid var(--color-border)",
        color: "var(--color-text-muted)",
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span style={{ color: connected ? "var(--color-success)" : "var(--color-warning)", fontWeight: 600 }}>
        {connected ? t("network.banner.connected", { master: worker.masterName ?? "" }) : t("network.banner.offline")}
      </span>
      <span>{t("network.banner.rules")}</span>
      {worker.applyError && <span style={{ color: "var(--color-danger)" }}>{t("network.banner.applyError", { reason: worker.applyError })}</span>}
    </div>
  );
}
