import { MasterPairingPayload } from "@gestion-boutique/network";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import { inputStyle, primaryButtonStyle, tableStyle, tdStyle, thStyle } from "../../components/sharedStyles";
import { useDeviceIdentityStore } from "../../stores/deviceIdentity";
import { useDeviceRoleStore } from "../../stores/deviceRole";
import { BarcodeCameraScanner, isCameraScanSupported } from "../sales/BarcodeCameraScanner";
import { isDesktopTauriRuntime } from "../settings/tauriRuntime";
import { useMasterServer } from "./useMasterServer";
import { useWorkerConnection } from "./useWorkerConnection";

const secondaryButtonStyle = {
  background: "transparent",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 14,
};

function RoleChoice() {
  const { t } = useTranslation();
  const { deviceName, setDeviceName } = useDeviceIdentityStore();
  const { setRole } = useDeviceRoleStore();
  const desktop = isDesktopTauriRuntime();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("network.intro")}</p>
      <label>
        {t("network.deviceName")}
        <input
          style={inputStyle}
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder={t("network.deviceNamePlaceholder")}
        />
      </label>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {desktop && (
          <button style={primaryButtonStyle} onClick={() => setRole("master")}>
            {t("network.becomeMaster")}
          </button>
        )}
        <button
          style={{
            ...primaryButtonStyle,
            background: "var(--color-bg)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
            boxShadow: "none",
          }}
          onClick={() => setRole("worker")}
        >
          {t("network.joinNetwork")}
        </button>
      </div>
      {!desktop && <p style={{ color: "var(--color-text-muted)", fontSize: 12, margin: 0 }}>{t("network.masterDesktopOnly")}</p>}
    </div>
  );
}

function MasterView() {
  const { t } = useTranslation();
  const db = useDatabase();
  const { deviceId, deviceName } = useDeviceIdentityStore();
  const { setRole } = useDeviceRoleStore();
  const { running, starting, pairingPayload, workers, error, start, stop } = useMasterServer(
    db,
    deviceId,
    deviceName.trim() || t("network.defaultMasterName"),
  );
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pairingPayload) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(pairingPayload.encode(), { margin: 1, width: 240 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pairingPayload]);

  const handleLeaveRole = async () => {
    if (running) await stop();
    setRole(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {running ? (
          <button style={secondaryButtonStyle} onClick={stop}>
            {t("network.master.stop")}
          </button>
        ) : (
          <button style={primaryButtonStyle} onClick={start} disabled={starting}>
            {starting ? t("network.master.starting") : t("network.master.start")}
          </button>
        )}
        <button style={secondaryButtonStyle} onClick={handleLeaveRole}>
          {t("network.leaveRole")}
        </button>
      </div>

      {error && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{error}</p>}

      {running && pairingPayload && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            {qrDataUrl && <img src={qrDataUrl} alt={t("network.master.qrAlt")} width={240} height={240} />}
            <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
              {pairingPayload.host}:{pairingPayload.port}
            </span>
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <strong style={{ fontSize: 14 }}>{t("network.master.connectedWorkers", { count: workers.length })}</strong>
            <div className="table-scroll">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>{t("network.master.workerName")}</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.connectionId}>
                      <td style={tdStyle}>{w.deviceName}</td>
                    </tr>
                  ))}
                  {workers.length === 0 && (
                    <tr>
                      <td style={tdStyle}>{t("network.master.noWorkers")}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ManualEntryForm({ onSubmit }: { onSubmit: (payload: MasterPairingPayload) => void }) {
  const { t } = useTranslation();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = () => {
    const portNumber = Number(port);
    if (!host.trim() || !Number.isInteger(portNumber) || portNumber <= 0 || !token.trim()) {
      setFormError(t("network.worker.manualEntryError"));
      return;
    }
    setFormError(null);
    onSubmit(
      new MasterPairingPayload({
        masterId: "manual",
        masterName: t("network.worker.manualMasterName"),
        host: host.trim(),
        port: portNumber,
        token: token.trim(),
      }),
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
      <label>
        {t("network.worker.host")}
        <input style={inputStyle} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.42" />
      </label>
      <label>
        {t("network.worker.port")}
        <input style={inputStyle} value={port} onChange={(e) => setPort(e.target.value)} placeholder="51820" />
      </label>
      <label>
        {t("network.worker.token")}
        <input style={inputStyle} value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      {formError && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{formError}</p>}
      <button style={primaryButtonStyle} onClick={handleSubmit}>
        {t("network.worker.connect")}
      </button>
    </div>
  );
}

function WorkerView() {
  const { t } = useTranslation();
  const db = useDatabase();
  const { deviceId, deviceName } = useDeviceIdentityStore();
  const { setRole } = useDeviceRoleStore();
  const {
    status,
    masterName,
    error,
    lastPayload,
    searching,
    searchError,
    connect,
    reconnect,
    disconnect,
    searchForMaster,
  } = useWorkerConnection(db, deviceId, deviceName.trim() || t("network.defaultWorkerName"));
  const [scanning, setScanning] = useState(false);

  const handleDetected = (raw: string) => {
    const payload = MasterPairingPayload.tryDecode(raw);
    setScanning(false);
    if (payload) connect(payload);
  };

  const handleLeaveRole = () => {
    disconnect();
    setRole(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ fontSize: 14 }}>
        {t("network.worker.status")}:{" "}
        <strong>{t(`network.worker.statusLabels.${status}`)}</strong>
        {status === "connected" && masterName ? ` (${masterName})` : ""}
      </p>

      {error && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{error}</p>}
      {searchError && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{searchError}</p>}

      {(status === "idle" || status === "error" || status === "disconnected") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {status === "disconnected" && (
              <button style={primaryButtonStyle} onClick={reconnect}>
                {t("network.worker.reconnect")}
              </button>
            )}
            {lastPayload && (
              <button style={secondaryButtonStyle} onClick={searchForMaster} disabled={searching}>
                {searching ? t("network.worker.searching") : t("network.worker.searchOnNetwork")}
              </button>
            )}
            {isCameraScanSupported() && (
              <button style={primaryButtonStyle} onClick={() => setScanning(true)}>
                {t("network.worker.scanQr")}
              </button>
            )}
          </div>
          <ManualEntryForm onSubmit={connect} />
        </div>
      )}

      {status === "connecting" && <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>{t("network.worker.connecting")}</p>}

      <div>
        <button style={secondaryButtonStyle} onClick={handleLeaveRole}>
          {t("network.leaveRole")}
        </button>
      </div>

      {scanning && <BarcodeCameraScanner onDetected={handleDetected} onClose={() => setScanning(false)} />}
    </div>
  );
}

// Configuration du mode réseau (Solo/Master/Worker) — voir CLAUDE.md, section
// mode réseau. Aucune donnée métier ne transite encore ici : cette section ne
// couvre que le rôle d'appareil et le pairage Master↔Worker.
export function NetworkSection() {
  const { t } = useTranslation();
  const role = useDeviceRoleStore((s) => s.role);

  return (
    <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
      <strong style={{ fontSize: 14 }}>{t("network.heading")}</strong>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "4px 0 12px" }}>{t("network.description")}</p>
      {role === null && <RoleChoice />}
      {role === "master" && <MasterView />}
      {role === "worker" && <WorkerView />}
    </div>
  );
}
