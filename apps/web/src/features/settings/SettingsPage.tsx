import {
  getSettings,
  hasMaintenanceCode,
  listBackups,
  recordBackup,
  restoreBackupFromFile,
  setMaintenanceCode,
  updateSettings,
  verifyMaintenanceCode,
  type BackupDestination,
} from "@gestion-boutique/core";
import { exportDatabaseFile, schema } from "@gestion-boutique/database";
import {
  isAndroidTauriRuntime,
  isFileSystemAccessSupported,
  loadFolderHandle,
  pickBackupFolder,
} from "@gestion-boutique/sync";
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDatabase } from "../../app/DatabaseProvider";
import {
  badgeStyle,
  cardStyle,
  inputStyle,
  pageStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "../../components/sharedStyles";
import { saveGeneratedFile } from "../../lib/saveFile";
import { useAuth } from "../auth/useAuth";
import { StoresSection } from "../stores/StoresSection";
import { runGoogleDriveBackup, runLocalBackup } from "./backupRunner";
import { resizeImageToDataUrl } from "./imageUtils";
import { SyscohadaAccountsSection } from "./SyscohadaAccountsSection";
import { isDesktopTauriRuntime } from "./tauriRuntime";

type Backup = typeof schema.backups.$inferSelect;

function timestampForFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

// Les commandes Tauri (openPath, etc.) rejettent souvent avec une simple
// chaîne renvoyée par le côté Rust, pas un vrai `Error` JS — `instanceof
// Error` seul avale alors ce message réel et affiche un texte de repli
// générique inutile pour diagnostiquer un échec (ex. installeur déplacé/
// supprimé par l'antivirus, permission refusée).
function describeError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export function SettingsPage() {
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();

  const FREQUENCY_PRESETS = [
    { value: "daily", label: t("settings.backups.frequencyDaily") },
    { value: "weekly", label: t("settings.backups.frequencyWeekly") },
    { value: "monthly", label: t("settings.backups.frequencyMonthly") },
    { value: "off", label: t("settings.backups.frequencyOff") },
  ];

  const DESTINATION_LABELS: Record<BackupDestination, string> = {
    local: t("settings.backups.destinationLocal"),
    google_drive: "Google Drive",
  };

  const RECEIPT_PRESETS = [
    { value: "32", label: t("settings.business.receipt58mm") },
    { value: "48", label: t("settings.business.receipt80mm") },
  ];

  const [loyaltyPointsRatio, setLoyaltyPointsRatio] = useState("0");
  const [loyaltyTierSilverThreshold, setLoyaltyTierSilverThreshold] = useState("5000");
  const [loyaltyTierGoldThreshold, setLoyaltyTierGoldThreshold] = useState("20000");
  const [loyaltyTierSilverMultiplier, setLoyaltyTierSilverMultiplier] = useState("1.25");
  const [loyaltyTierGoldMultiplier, setLoyaltyTierGoldMultiplier] = useState("1.5");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [businessName, setBusinessName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [whatsappCountryCode, setWhatsappCountryCode] = useState("");
  const [lowStockAlertPhone, setLowStockAlertPhone] = useState("");
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [defaultTaxRate, setDefaultTaxRate] = useState("0");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [receiptPreset, setReceiptPreset] = useState("32");
  const [customColumns, setCustomColumns] = useState("32");
  const [enableServiceOrders, setEnableServiceOrders] = useState(false);
  const [enablePromotions, setEnablePromotions] = useState(false);
  const [printPromisedDateOnTicket, setPrintPromisedDateOnTicket] = useState(true);
  const [enableSales, setEnableSales] = useState(true);
  const [enableProducts, setEnableProducts] = useState(true);
  const [enableStock, setEnableStock] = useState(true);
  const [enableSuppliers, setEnableSuppliers] = useState(true);
  const [enablePurchases, setEnablePurchases] = useState(true);
  const [multiStoreEnabled, setMultiStoreEnabled] = useState(false);
  const [enableSyscohada, setEnableSyscohada] = useState(false);
  const [autoLockMinutes, setAutoLockMinutes] = useState("0");

  const [frequencyPreset, setFrequencyPreset] = useState("weekly");
  const [customDays, setCustomDays] = useState("7");
  const [googleDriveClientId, setGoogleDriveClientId] = useState("");
  const [folderName, setFolderName] = useState<string | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);

  const [backupError, setBackupError] = useState<string | null>(null);
  const [runningLocal, setRunningLocal] = useState(false);
  const [runningDrive, setRunningDrive] = useState(false);
  const [downloadBackupError, setDownloadBackupError] = useState<string | null>(null);
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importInfo, setImportInfo] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const [maintenanceCodeSet, setMaintenanceCodeSet] = useState(false);
  const [currentMaintenanceCode, setCurrentMaintenanceCode] = useState("");
  const [newMaintenanceCode, setNewMaintenanceCode] = useState("");
  const [maintenanceCodeError, setMaintenanceCodeError] = useState<string | null>(null);
  const [maintenanceCodeSaved, setMaintenanceCodeSaved] = useState(false);
  const [savingMaintenanceCode, setSavingMaintenanceCode] = useState(false);

  const [updateFilePath, setUpdateFilePath] = useState<string | null>(null);
  const [updateCode, setUpdateCode] = useState("");
  const [updateStep, setUpdateStep] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateReadyToClose, setUpdateReadyToClose] = useState(false);

  const refresh = useCallback(async () => {
    const [settings, backupRows, handle, maintenanceCodeIsSet] = await Promise.all([
      getSettings(db),
      listBackups(db),
      loadFolderHandle(),
      hasMaintenanceCode(db),
    ]);
    setMaintenanceCodeSet(maintenanceCodeIsSet);
    setLoyaltyPointsRatio(String(settings.loyaltyPointsRatio));
    setLoyaltyTierSilverThreshold(String(settings.loyaltyTierSilverThreshold));
    setLoyaltyTierGoldThreshold(String(settings.loyaltyTierGoldThreshold));
    setLoyaltyTierSilverMultiplier(String(settings.loyaltyTierSilverMultiplier));
    setLoyaltyTierGoldMultiplier(String(settings.loyaltyTierGoldMultiplier));
    setGoogleDriveClientId(settings.googleDriveClientId ?? "");
    setBackups(backupRows);
    setFolderName(handle?.name ?? null);

    setBusinessName(settings.businessName ?? "");
    setAddress(settings.address ?? "");
    setPhone(settings.phone ?? "");
    setEmail(settings.email ?? "");
    setWhatsappCountryCode(settings.whatsappCountryCode ?? "");
    setLowStockAlertPhone(settings.lowStockAlertPhone ?? "");
    setTaxEnabled(settings.taxEnabled);
    setDefaultTaxRate(String(settings.defaultTaxRate));
    setLogoDataUrl(settings.logoDataUrl ?? null);
    setEnableServiceOrders(settings.enableServiceOrders);
    setEnablePromotions(settings.enablePromotions);
    setPrintPromisedDateOnTicket(settings.printPromisedDateOnTicket);
    setEnableSales(settings.enableSales);
    setEnableProducts(settings.enableProducts);
    setEnableStock(settings.enableStock);
    setEnableSuppliers(settings.enableSuppliers);
    setEnablePurchases(settings.enablePurchases);
    setMultiStoreEnabled(settings.multiStoreEnabled);
    setEnableSyscohada(settings.enableSyscohada);
    setAutoLockMinutes(String(settings.autoLockMinutes));

    const isReceiptPreset = RECEIPT_PRESETS.some((p) => p.value === String(settings.receiptColumns));
    if (isReceiptPreset) {
      setReceiptPreset(String(settings.receiptColumns));
    } else {
      setReceiptPreset("custom");
      setCustomColumns(String(settings.receiptColumns));
    }

    const isPreset = FREQUENCY_PRESETS.some((p) => p.value === settings.backupFrequency);
    if (isPreset) {
      setFrequencyPreset(settings.backupFrequency);
    } else {
      setFrequencyPreset("custom");
      setCustomDays(settings.backupFrequency);
    }
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSubmit = async () => {
    setError(null);
    setSaved(false);
    const ratio = Number(loyaltyPointsRatio);
    if (Number.isNaN(ratio) || ratio < 0) {
      setError(t("settings.errors.loyaltyRatio"));
      return;
    }

    const silverThreshold = Number(loyaltyTierSilverThreshold);
    const goldThreshold = Number(loyaltyTierGoldThreshold);
    const silverMultiplier = Number(loyaltyTierSilverMultiplier);
    const goldMultiplier = Number(loyaltyTierGoldMultiplier);
    if (
      [silverThreshold, goldThreshold, silverMultiplier, goldMultiplier].some((n) => Number.isNaN(n) || n < 0)
    ) {
      setError(t("settings.errors.loyaltyTiers"));
      return;
    }
    if (goldThreshold < silverThreshold) {
      setError(t("settings.errors.goldThreshold"));
      return;
    }

    const backupFrequency = frequencyPreset === "custom" ? customDays.trim() : frequencyPreset;
    if (frequencyPreset === "custom" && (!/^\d+$/.test(backupFrequency) || Number(backupFrequency) < 0)) {
      setError(t("settings.errors.customBackupDays"));
      return;
    }

    const receiptColumns = receiptPreset === "custom" ? Number(customColumns) : Number(receiptPreset);
    if (
      receiptPreset === "custom" &&
      (!/^\d+$/.test(customColumns) || receiptColumns < 20 || receiptColumns > 64)
    ) {
      setError(t("settings.errors.receiptColumns"));
      return;
    }

    const autoLockValue = Number(autoLockMinutes);
    if (!/^\d+$/.test(autoLockMinutes) || autoLockValue < 0) {
      setError(t("settings.errors.autoLock"));
      return;
    }

    const taxRateValue = Number(defaultTaxRate);
    if (taxEnabled && (Number.isNaN(taxRateValue) || taxRateValue < 0 || taxRateValue >= 100)) {
      setError(t("settings.errors.taxRate"));
      return;
    }

    setSaving(true);
    try {
      await updateSettings(
        db,
        {
          loyaltyPointsRatio: ratio,
          loyaltyTierSilverThreshold: silverThreshold,
          loyaltyTierGoldThreshold: goldThreshold,
          loyaltyTierSilverMultiplier: silverMultiplier,
          loyaltyTierGoldMultiplier: goldMultiplier,
          backupFrequency,
          googleDriveClientId: googleDriveClientId.trim() || undefined,
          businessName: businessName.trim() || undefined,
          address: address.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          whatsappCountryCode: whatsappCountryCode.trim() || undefined,
          lowStockAlertPhone: lowStockAlertPhone.trim() || undefined,
          taxEnabled,
          defaultTaxRate: taxRateValue,
          logoDataUrl,
          receiptColumns,
          enableServiceOrders,
          enablePromotions,
          printPromisedDateOnTicket,
          enableSales,
          enableProducts,
          enableStock,
          enableSuppliers,
          enablePurchases,
          multiStoreEnabled,
          enableSyscohada,
          autoLockMinutes: autoLockValue,
        },
        user?.permissions ?? {},
      );
      setSaved(true);
    } catch (err) {
      setError(describeError(err, t("settings.errors.genericSave")));
    } finally {
      setSaving(false);
    }
  };

  const handleLogoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setLogoError(null);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      setLogoDataUrl(dataUrl);
    } catch (err) {
      setLogoError(describeError(err, t("settings.errors.logo")));
    }
  };

  const handlePickFolder = async () => {
    setBackupError(null);
    try {
      const handle = await pickBackupFolder();
      setFolderName(handle.name);
    } catch (err) {
      setBackupError(describeError(err, t("settings.errors.folder")));
    }
  };

  const handleLocalBackupNow = async () => {
    setBackupError(null);
    setRunningLocal(true);
    try {
      await runLocalBackup(db);
      await refresh();
    } catch (err) {
      setBackupError(describeError(err, t("settings.errors.localBackup")));
    } finally {
      setRunningLocal(false);
    }
  };

  const handleManualDownloadBackup = async () => {
    setDownloadBackupError(null);
    setDownloadingBackup(true);
    try {
      const { bytes, filename } = await exportDatabaseFile();
      await saveGeneratedFile(new Blob([new Uint8Array(bytes)]), filename);
      await recordBackup(db, { destination: "local", fileRef: filename, status: "success" });
      await refresh();
    } catch (err) {
      setDownloadBackupError(describeError(err, t("settings.errors.downloadBackup")));
    } finally {
      setDownloadingBackup(false);
    }
  };

  const handleDriveBackupNow = async () => {
    setBackupError(null);
    if (!googleDriveClientId.trim()) {
      setBackupError(t("settings.backups.clientIdRequired"));
      return;
    }
    setRunningDrive(true);
    try {
      await runGoogleDriveBackup(db, googleDriveClientId.trim());
      await refresh();
    } catch (err) {
      setBackupError(describeError(err, t("settings.errors.driveBackup")));
    } finally {
      setRunningDrive(false);
    }
  };

  const handleImportBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!window.confirm(t("settings.backups.importConfirm"))) {
      return;
    }
    setImportError(null);
    setImportInfo(null);
    setImporting(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { previousBytes } = await restoreBackupFromFile(bytes, user?.permissions ?? {});
      // Filet de sécurité : l'état d'avant l'import reste téléchargeable
      // immédiatement si la sauvegarde importée s'avère finalement inadaptée
      // une fois la page rechargée.
      await saveGeneratedFile(new Blob([new Uint8Array(previousBytes)]), `avant-import-${timestampForFilename()}.sqlite3`);
      setImportInfo(t("settings.backups.importSuccess"));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      window.location.reload();
    } catch (err) {
      setImportError(describeError(err, t("settings.errors.import")));
      setImporting(false);
    }
  };

  const handleSaveMaintenanceCode = async () => {
    setMaintenanceCodeError(null);
    setMaintenanceCodeSaved(false);
    if (!user) return;
    setSavingMaintenanceCode(true);
    try {
      await setMaintenanceCode(db, {
        newCode: newMaintenanceCode,
        currentCode: maintenanceCodeSet ? currentMaintenanceCode : undefined,
        userId: user.id,
        actingPermissions: user.permissions,
      });
      setMaintenanceCodeSet(true);
      setCurrentMaintenanceCode("");
      setNewMaintenanceCode("");
      setMaintenanceCodeSaved(true);
    } catch (err) {
      setMaintenanceCodeError(describeError(err, t("settings.errors.maintenanceCode")));
    } finally {
      setSavingMaintenanceCode(false);
    }
  };

  const handlePickUpdateFile = async () => {
    setUpdateError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "Installeur WariBox", extensions: ["exe", "msi"] }],
      });
      if (typeof path === "string") setUpdateFilePath(path);
    } catch (err) {
      setUpdateError(describeError(err, t("settings.errors.updateFilePicker")));
    }
  };

  const handleInstallUpdate = async () => {
    setUpdateError(null);
    setUpdateStep(null);
    setUpdateReadyToClose(false);
    if (!updateFilePath) {
      setUpdateError(t("settings.errors.updateNoFile"));
      return;
    }
    if (!updateCode.trim()) {
      setUpdateError(t("settings.errors.updateNoCode"));
      return;
    }

    setUpdating(true);
    try {
      const valid = await verifyMaintenanceCode(db, updateCode.trim());
      if (!valid) throw new Error(t("settings.errors.updateWrongCode"));

      setUpdateStep(t("settings.updateStep.backingUp"));
      try {
        await runLocalBackup(db);
      } catch (backupErr) {
        // Sauvegarde "best effort" : un dossier non configuré (ou une
        // permission expirée) ne doit plus bloquer une mise à jour urgente —
        // on avertit et on continue plutôt que d'interrompre tout le flux.
        setUpdateStep(
          t("settings.updateStep.backupSkipped", {
            error: backupErr instanceof Error ? backupErr.message : t("settings.errors.backupSkippedUnknown"),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      setUpdateStep(t("settings.updateStep.launching"));
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(updateFilePath);

      // openPath() ne garantit que la demande de lancement, pas que la
      // fenêtre de l'installeur (ni un éventuel écran SmartScreen "Windows a
      // protégé votre PC", très probable pour un fichier non signé reçu par
      // téléchargement/email/WhatsApp) ait eu le temps de s'afficher. Fermer
      // WariBox sur un délai fixe risquait de couper l'app avant que
      // l'utilisateur n'ait pu réagir à cet écran, laissant croire que la
      // mise à jour "ne fait rien" — la fermeture est donc maintenant
      // déclenchée manuellement, une fois l'assistant réellement visible.
      setUpdateStep(t("settings.updateStep.readyMessage"));
      setUpdateReadyToClose(true);
    } catch (err) {
      setUpdateError(describeError(err, t("settings.errors.updateFailed")));
      setUpdateStep(null);
    } finally {
      setUpdating(false);
    }
  };

  const handleCloseForUpdate = async () => {
    const { exit } = await import("@tauri-apps/plugin-process");
    await exit(0);
  };

  return (
    <main style={pageStyle}>
      <h1>{t("settings.title")}</h1>

      <div style={cardStyle}>
        <strong>{t("settings.business.heading")}</strong>
        <label>
          {t("settings.business.name")}
          <input
            style={inputStyle}
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="WariBox"
          />
        </label>

        <label>
          {t("settings.business.address")}
          <input style={inputStyle} value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          {t("settings.business.phone")}
          <input style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label>
          {t("settings.business.email")}
          <input
            type="email"
            style={inputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          {t("settings.business.whatsappCountryCode")}
          <input
            style={inputStyle}
            value={whatsappCountryCode}
            onChange={(e) => setWhatsappCountryCode(e.target.value)}
            placeholder="ex: 225"
          />
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          {t("settings.business.whatsappCountryCodeHint")}
        </p>
        <label>
          {t("settings.business.lowStockAlertPhone")}
          <input
            style={inputStyle}
            value={lowStockAlertPhone}
            onChange={(e) => setLowStockAlertPhone(e.target.value)}
            placeholder="ex: 0708000000"
          />
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          {t("settings.business.lowStockAlertPhoneHint")}
        </p>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={taxEnabled} onChange={(e) => setTaxEnabled(e.target.checked)} />
          {t("settings.business.applyTax")}
        </label>
        {taxEnabled && (
          <label style={{ marginLeft: 24 }}>
            {t("settings.business.defaultTaxRate")}
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={99}
              value={defaultTaxRate}
              onChange={(e) => setDefaultTaxRate(e.target.value)}
            />
          </label>
        )}
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          {t("settings.business.taxHint")}
        </p>

        <div>
          <strong style={{ fontSize: 14 }}>{t("settings.business.logo")}</strong>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
            {logoDataUrl && (
              <img
                src={logoDataUrl}
                alt={t("settings.business.logoAlt")}
                style={{ width: 56, height: 56, objectFit: "contain", background: "#fff", borderRadius: 8 }}
              />
            )}
            <input type="file" accept="image/*" onChange={handleLogoChange} />
            {logoDataUrl && (
              <button
                type="button"
                style={{
                  ...primaryButtonStyle,
                  padding: "6px 12px",
                  fontSize: 13,
                  background: "transparent",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
                onClick={() => setLogoDataUrl(null)}
              >
                {t("settings.business.removeLogo")}
              </button>
            )}
          </div>
          {logoError && (
            <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{logoError}</p>
          )}
        </div>

        <label>
          {t("settings.business.receiptFormat")}
          <select
            style={inputStyle}
            value={receiptPreset}
            onChange={(e) => setReceiptPreset(e.target.value)}
          >
            {RECEIPT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="custom">{t("settings.business.receiptCustom")}</option>
          </select>
        </label>
        {receiptPreset === "custom" && (
          <label>
            {t("settings.business.receiptCharsPerLine")}
            <input
              style={inputStyle}
              type="number"
              min={20}
              max={64}
              value={customColumns}
              onChange={(e) => setCustomColumns(e.target.value)}
            />
          </label>
        )}

      </div>

      <div style={cardStyle}>
        <strong>{t("settings.modules.heading")}</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.modules.hint")}</p>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={enableSales} onChange={(e) => setEnableSales(e.target.checked)} />
          {t("settings.modules.sales")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enableProducts}
            onChange={(e) => setEnableProducts(e.target.checked)}
          />
          {t("settings.modules.products")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={enableStock} onChange={(e) => setEnableStock(e.target.checked)} />
          {t("settings.modules.stock")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enableSuppliers}
            onChange={(e) => setEnableSuppliers(e.target.checked)}
          />
          {t("settings.modules.suppliers")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enablePurchases}
            onChange={(e) => setEnablePurchases(e.target.checked)}
          />
          {t("settings.modules.purchases")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enableServiceOrders}
            onChange={(e) => setEnableServiceOrders(e.target.checked)}
          />
          {t("settings.modules.serviceOrders")}
        </label>
        {enableServiceOrders && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 24 }}>
            <input
              type="checkbox"
              checked={printPromisedDateOnTicket}
              onChange={(e) => setPrintPromisedDateOnTicket(e.target.checked)}
            />
            {t("settings.modules.printPromisedDate")}
          </label>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enablePromotions}
            onChange={(e) => setEnablePromotions(e.target.checked)}
          />
          {t("settings.modules.promotions")}
        </label>
      </div>

      <div style={cardStyle}>
        <strong>{t("settings.multiStore.heading")}</strong>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={multiStoreEnabled}
            onChange={(e) => setMultiStoreEnabled(e.target.checked)}
          />
          {t("settings.multiStore.enable")}
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.multiStore.hint")}</p>
        {multiStoreEnabled && <StoresSection />}
      </div>

      <div style={cardStyle}>
        <strong>{t("settings.syscohada.heading")}</strong>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enableSyscohada}
            onChange={(e) => setEnableSyscohada(e.target.checked)}
          />
          {t("settings.syscohada.enable")}
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.syscohada.hint")}</p>
        {enableSyscohada && <SyscohadaAccountsSection />}
      </div>

      <div style={cardStyle}>
        <strong>{t("settings.loyalty.heading")}</strong>
        <label>
          {t("settings.loyalty.ratio")}
          <input
            style={inputStyle}
            type="number"
            step="0.001"
            min="0"
            value={loyaltyPointsRatio}
            onChange={(e) => setLoyaltyPointsRatio(e.target.value)}
          />
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.loyalty.ratioHint")}</p>

        <strong style={{ marginTop: 16, display: "block" }}>{t("settings.loyalty.tiers")}</strong>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>
            {t("settings.loyalty.silverThreshold")}
            <input
              style={inputStyle}
              type="number"
              min="0"
              value={loyaltyTierSilverThreshold}
              onChange={(e) => setLoyaltyTierSilverThreshold(e.target.value)}
            />
          </label>
          <label>
            {t("settings.loyalty.goldThreshold")}
            <input
              style={inputStyle}
              type="number"
              min="0"
              value={loyaltyTierGoldThreshold}
              onChange={(e) => setLoyaltyTierGoldThreshold(e.target.value)}
            />
          </label>
          <label>
            {t("settings.loyalty.silverMultiplier")}
            <input
              style={inputStyle}
              type="number"
              step="0.01"
              min="0"
              value={loyaltyTierSilverMultiplier}
              onChange={(e) => setLoyaltyTierSilverMultiplier(e.target.value)}
            />
          </label>
          <label>
            {t("settings.loyalty.goldMultiplier")}
            <input
              style={inputStyle}
              type="number"
              step="0.01"
              min="0"
              value={loyaltyTierGoldMultiplier}
              onChange={(e) => setLoyaltyTierGoldMultiplier(e.target.value)}
            />
          </label>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.loyalty.tiersHint")}</p>
      </div>

      <div style={cardStyle}>
        <strong>{t("settings.security.heading")}</strong>
        <label>
          {t("settings.security.autoLock")}
          <input
            style={inputStyle}
            type="number"
            min="0"
            value={autoLockMinutes}
            onChange={(e) => setAutoLockMinutes(e.target.value)}
          />
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.security.autoLockHint")}</p>
      </div>

      <div style={cardStyle}>
        <strong>{t("settings.backups.heading")}</strong>

        <label>
          {t("settings.backups.frequency")}
          <select
            style={inputStyle}
            value={frequencyPreset}
            onChange={(e) => setFrequencyPreset(e.target.value)}
          >
            {FREQUENCY_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="custom">{t("settings.backups.frequencyCustom")}</option>
          </select>
        </label>
        {frequencyPreset === "custom" && (
          <label>
            {t("settings.backups.customDays")}
            <input
              style={inputStyle}
              type="number"
              min="0"
              value={customDays}
              onChange={(e) => setCustomDays(e.target.value)}
            />
          </label>
        )}

        <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
          <strong style={{ fontSize: 14 }}>{t("settings.backups.localHeading")}</strong>
          {isFileSystemAccessSupported() ? (
            <>
              <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                {t("settings.backups.currentFolder")} {folderName ?? t("settings.backups.noFolder")}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14 }}
                  onClick={handlePickFolder}
                >
                  {t("settings.backups.chooseFolder")}
                </button>
                <button
                  style={{
                    ...primaryButtonStyle,
                    padding: "8px 14px",
                    fontSize: 14,
                    background: "transparent",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text)",
                  }}
                  onClick={handleLocalBackupNow}
                  disabled={runningLocal || !folderName}
                >
                  {runningLocal ? t("settings.backups.backingUp") : t("settings.backups.backupNow")}
                </button>
              </div>
            </>
          ) : isAndroidTauriRuntime() ? (
            <>
              <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("settings.backups.androidAutoLocation")}</p>
              <button
                style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14 }}
                onClick={handleLocalBackupNow}
                disabled={runningLocal}
              >
                {runningLocal ? t("settings.backups.backingUp") : t("settings.backups.backupNow")}
              </button>
            </>
          ) : (
            <>
              <p style={{ color: "var(--color-warning)", fontSize: 13 }}>{t("settings.backups.noFsSupport")}</p>
              <button
                style={{
                  ...primaryButtonStyle,
                  padding: "8px 14px",
                  fontSize: 14,
                  background: "transparent",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
                onClick={handleManualDownloadBackup}
                disabled={downloadingBackup}
              >
                {downloadingBackup ? t("settings.backups.downloading") : t("settings.backups.downloadNow")}
              </button>
              {downloadBackupError && (
                <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{downloadBackupError}</p>
              )}
            </>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
          <strong style={{ fontSize: 14 }}>{t("settings.backups.importHeading")}</strong>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("settings.backups.importHint")}</p>
          <label
            style={{
              ...primaryButtonStyle,
              padding: "8px 14px",
              fontSize: 14,
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              cursor: importing ? "default" : "pointer",
              display: "inline-block",
            }}
          >
            {importing ? t("settings.backups.importing") : t("settings.backups.import")}
            <input
              type="file"
              accept=".sqlite3"
              onChange={handleImportBackup}
              disabled={importing}
              style={{ display: "none" }}
            />
          </label>
          {importError && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{importError}</p>}
          {importInfo && <p style={{ color: "var(--color-success)", fontSize: 13 }}>{importInfo}</p>}
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
          <strong style={{ fontSize: 14 }}>{t("settings.backups.driveHeading")}</strong>
          <label>
            {t("settings.backups.driveClientId")}
            <input
              style={inputStyle}
              value={googleDriveClientId}
              onChange={(e) => setGoogleDriveClientId(e.target.value)}
              placeholder="xxxxxxxxxxxx.apps.googleusercontent.com"
            />
          </label>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("settings.backups.driveHint")}</p>
          <button
            style={{
              ...primaryButtonStyle,
              padding: "8px 14px",
              fontSize: 14,
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
            }}
            onClick={handleDriveBackupNow}
            disabled={runningDrive}
          >
            {runningDrive ? t("settings.backups.connecting") : t("settings.backups.connectAndBackup")}
          </button>
        </div>

        {backupError && <p style={{ color: "var(--color-danger)" }}>{backupError}</p>}

        <div className="table-scroll">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t("settings.backups.date")}</th>
                <th style={thStyle}>{t("settings.backups.destination")}</th>
                <th style={thStyle}>{t("settings.backups.status")}</th>
                <th style={thStyle}>{t("settings.backups.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {backups.slice(0, 10).map((b) => (
                <tr key={b.id}>
                  <td style={tdStyle}>{b.createdAt}</td>
                  <td style={tdStyle}>{DESTINATION_LABELS[b.destination as BackupDestination] ?? b.destination}</td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(b.status === "success" ? "ok" : "warning")}>
                      {b.status === "success" ? t("settings.backups.success") : t("settings.backups.failure")}
                    </span>
                  </td>
                  <td style={tdStyle}>{b.fileRef ?? "—"}</td>
                </tr>
              ))}
              {backups.length === 0 && (
                <tr>
                  <td style={tdStyle} colSpan={4}>
                    {t("settings.backups.none")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={cardStyle}>
        <strong>{t("settings.maintenance.heading")}</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.maintenance.hint")}</p>
        {maintenanceCodeSet && (
          <label>
            {t("settings.maintenance.currentCode")}
            <input
              style={inputStyle}
              type="password"
              value={currentMaintenanceCode}
              onChange={(e) => setCurrentMaintenanceCode(e.target.value)}
            />
          </label>
        )}
        <label>
          {maintenanceCodeSet ? t("settings.maintenance.newCode") : t("settings.maintenance.setCode")}
          <input
            style={inputStyle}
            type="password"
            value={newMaintenanceCode}
            onChange={(e) => setNewMaintenanceCode(e.target.value)}
            placeholder={t("settings.maintenance.codePlaceholder")}
          />
        </label>
        {maintenanceCodeError && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{maintenanceCodeError}</p>}
        {maintenanceCodeSaved && <p style={{ color: "var(--color-success)", fontSize: 13 }}>{t("settings.maintenance.codeSaved")}</p>}
        <button
          style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14, alignSelf: "flex-start" }}
          onClick={handleSaveMaintenanceCode}
          disabled={savingMaintenanceCode || !newMaintenanceCode}
        >
          {savingMaintenanceCode ? t("settings.maintenance.saving") : t("settings.maintenance.saveCode")}
        </button>

        {isDesktopTauriRuntime() && (
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
            <strong style={{ fontSize: 14 }}>{t("settings.maintenance.updateHeading")}</strong>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{t("settings.maintenance.updateHint")}</p>
            <p style={{ color: "var(--color-caution)", fontSize: 13 }}>{t("settings.maintenance.updateWarning")}</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                style={{
                  ...primaryButtonStyle,
                  padding: "8px 14px",
                  fontSize: 14,
                  background: "transparent",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
                onClick={handlePickUpdateFile}
                disabled={updating}
              >
                {updateFilePath ? t("settings.maintenance.changeFile") : t("settings.maintenance.chooseFile")}
              </button>
              {updateFilePath && <span style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{updateFilePath}</span>}
            </div>
            <label>
              {t("settings.maintenance.maintenanceCodeLabel")}
              <input
                style={inputStyle}
                type="password"
                value={updateCode}
                onChange={(e) => setUpdateCode(e.target.value)}
              />
            </label>
            {updateStep && <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{updateStep}</p>}
            {updateError && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{updateError}</p>}
            {updateReadyToClose ? (
              <button
                style={{
                  ...primaryButtonStyle,
                  padding: "8px 14px",
                  fontSize: 14,
                  alignSelf: "flex-start",
                  background: "#f87171",
                }}
                onClick={handleCloseForUpdate}
              >
                {t("settings.maintenance.closeNow")}
              </button>
            ) : (
              <button
                style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14, alignSelf: "flex-start" }}
                onClick={handleInstallUpdate}
                disabled={updating || !maintenanceCodeSet}
                title={!maintenanceCodeSet ? t("settings.maintenance.defineCodeFirst") : undefined}
              >
                {updating ? t("settings.maintenance.installing") : t("settings.maintenance.launchInstaller")}
              </button>
            )}
          </div>
        )}
      </div>

      {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}
      {saved && <p style={{ color: "var(--color-success)" }}>{t("settings.saved")}</p>}

      <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
        {saving ? t("settings.saving") : t("settings.save")}
      </button>
    </main>
  );
}
