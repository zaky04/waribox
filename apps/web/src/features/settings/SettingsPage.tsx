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
  isFileSystemAccessSupported,
  loadFolderHandle,
  pickBackupFolder,
} from "@gestion-boutique/sync";
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
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
import { useAuth } from "../auth/useAuth";
import { StoresSection } from "../stores/StoresSection";
import { runGoogleDriveBackup, runLocalBackup } from "./backupRunner";
import { resizeImageToDataUrl } from "./imageUtils";
import { SyscohadaAccountsSection } from "./SyscohadaAccountsSection";
import { isTauriRuntime } from "./tauriRuntime";

type Backup = typeof schema.backups.$inferSelect;

function timestampForFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const FREQUENCY_PRESETS = [
  { value: "daily", label: "Quotidienne" },
  { value: "weekly", label: "Hebdomadaire" },
  { value: "monthly", label: "Mensuelle" },
  { value: "off", label: "Désactivée" },
];

const DESTINATION_LABELS: Record<BackupDestination, string> = {
  local: "Locale",
  google_drive: "Google Drive",
};

const RECEIPT_PRESETS = [
  { value: "32", label: "58 mm (32 caractères)" },
  { value: "48", label: "80 mm (48 caractères)" },
];

export function SettingsPage() {
  const db = useDatabase();
  const { user } = useAuth();

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
      setError("Le taux doit être un nombre positif ou nul.");
      return;
    }

    const silverThreshold = Number(loyaltyTierSilverThreshold);
    const goldThreshold = Number(loyaltyTierGoldThreshold);
    const silverMultiplier = Number(loyaltyTierSilverMultiplier);
    const goldMultiplier = Number(loyaltyTierGoldMultiplier);
    if (
      [silverThreshold, goldThreshold, silverMultiplier, goldMultiplier].some((n) => Number.isNaN(n) || n < 0)
    ) {
      setError("Les seuils et multiplicateurs de palier doivent être des nombres positifs ou nuls.");
      return;
    }
    if (goldThreshold < silverThreshold) {
      setError("Le seuil du palier Or doit être supérieur ou égal au seuil du palier Argent.");
      return;
    }

    const backupFrequency = frequencyPreset === "custom" ? customDays.trim() : frequencyPreset;
    if (frequencyPreset === "custom" && (!/^\d+$/.test(backupFrequency) || Number(backupFrequency) < 0)) {
      setError("Le délai personnalisé doit être un nombre de jours entier positif.");
      return;
    }

    const receiptColumns = receiptPreset === "custom" ? Number(customColumns) : Number(receiptPreset);
    if (
      receiptPreset === "custom" &&
      (!/^\d+$/.test(customColumns) || receiptColumns < 20 || receiptColumns > 64)
    ) {
      setError("La largeur personnalisée du ticket doit être un nombre de caractères entre 20 et 64.");
      return;
    }

    const autoLockValue = Number(autoLockMinutes);
    if (!/^\d+$/.test(autoLockMinutes) || autoLockValue < 0) {
      setError("Le délai de verrouillage automatique doit être un nombre de minutes positif ou nul.");
      return;
    }

    const taxRateValue = Number(defaultTaxRate);
    if (taxEnabled && (Number.isNaN(taxRateValue) || taxRateValue < 0 || taxRateValue >= 100)) {
      setError("Le taux de TVA doit être un nombre entre 0 et 99.");
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
      setError(err instanceof Error ? err.message : "Impossible d'enregistrer les paramètres.");
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
      setLogoError(err instanceof Error ? err.message : "Impossible de charger cette image.");
    }
  };

  const handlePickFolder = async () => {
    setBackupError(null);
    try {
      const handle = await pickBackupFolder();
      setFolderName(handle.name);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Impossible de choisir un dossier.");
    }
  };

  const handleLocalBackupNow = async () => {
    setBackupError(null);
    setRunningLocal(true);
    try {
      await runLocalBackup(db);
      await refresh();
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Échec de la sauvegarde locale.");
    } finally {
      setRunningLocal(false);
    }
  };

  const handleManualDownloadBackup = async () => {
    setDownloadBackupError(null);
    setDownloadingBackup(true);
    try {
      const { bytes, filename } = await exportDatabaseFile();
      downloadBlob(new Blob([new Uint8Array(bytes)]), filename);
      await recordBackup(db, { destination: "local", fileRef: filename, status: "success" });
      await refresh();
    } catch (err) {
      setDownloadBackupError(err instanceof Error ? err.message : "Échec du téléchargement de la sauvegarde.");
    } finally {
      setDownloadingBackup(false);
    }
  };

  const handleDriveBackupNow = async () => {
    setBackupError(null);
    if (!googleDriveClientId.trim()) {
      setBackupError("Renseigne un Client ID Google avant de te connecter.");
      return;
    }
    setRunningDrive(true);
    try {
      await runGoogleDriveBackup(db, googleDriveClientId.trim());
      await refresh();
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Échec de la sauvegarde Google Drive.");
    } finally {
      setRunningDrive(false);
    }
  };

  const handleImportBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (
      !window.confirm(
        "Cette action remplace TOUTES les données actuelles par celles de cette sauvegarde. Continuer ?",
      )
    ) {
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
      downloadBlob(new Blob([new Uint8Array(previousBytes)]), `avant-import-${timestampForFilename()}.sqlite3`);
      setImportInfo("Import réussi — la base précédente a été téléchargée par sécurité. Rechargement...");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      window.location.reload();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import impossible.");
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
      setMaintenanceCodeError(err instanceof Error ? err.message : "Impossible d'enregistrer le code.");
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
      setUpdateError(err instanceof Error ? err.message : "Impossible d'ouvrir le sélecteur de fichier.");
    }
  };

  const handleInstallUpdate = async () => {
    setUpdateError(null);
    setUpdateStep(null);
    setUpdateReadyToClose(false);
    if (!updateFilePath) {
      setUpdateError("Choisis d'abord le fichier d'installation apporté.");
      return;
    }
    if (!updateCode.trim()) {
      setUpdateError("Saisis le code de maintenance.");
      return;
    }

    setUpdating(true);
    try {
      const valid = await verifyMaintenanceCode(db, updateCode.trim());
      if (!valid) throw new Error("Code de maintenance incorrect.");

      setUpdateStep("Sauvegarde locale en cours...");
      try {
        await runLocalBackup(db);
      } catch (backupErr) {
        // Sauvegarde "best effort" : un dossier non configuré (ou une
        // permission expirée) ne doit plus bloquer une mise à jour urgente —
        // on avertit et on continue plutôt que d'interrompre tout le flux.
        setUpdateStep(
          `Sauvegarde non effectuée (${
            backupErr instanceof Error ? backupErr.message : "erreur inconnue"
          }) — poursuite de l'installation.`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      setUpdateStep("Lancement de l'installeur...");
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
      setUpdateStep(
        "Une fenêtre d'installation devrait s'ouvrir. Si Windows affiche « Windows a protégé " +
          "votre PC », c'est normal pour un installeur non signé : clique sur « Informations " +
          "complémentaires » puis « Exécuter quand même ». Une fois l'assistant d'installation " +
          "visible, clique ci-dessous pour fermer WariBox et laisser l'installation continuer.",
      );
      setUpdateReadyToClose(true);
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Mise à jour impossible.");
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
      <h1>Paramètres</h1>

      <div style={cardStyle}>
        <strong>Entreprise</strong>
        <label>
          Nom de l'entreprise
          <input
            style={inputStyle}
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="WariBox"
          />
        </label>

        <label>
          Adresse
          <input style={inputStyle} value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          Téléphone
          <input style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label>
          Email
          <input
            type="email"
            style={inputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Indicatif pays WhatsApp
          <input
            style={inputStyle}
            value={whatsappCountryCode}
            onChange={(e) => setWhatsappCountryCode(e.target.value)}
            placeholder="ex: 225"
          />
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Utilisé pour compléter les numéros de téléphone locaux des clients lors de l'envoi d'une
          notification WhatsApp (ex : ticket de service prêt).
        </p>
        <label>
          Téléphone à notifier (alertes stock bas)
          <input
            style={inputStyle}
            value={lowStockAlertPhone}
            onChange={(e) => setLowStockAlertPhone(e.target.value)}
            placeholder="ex: 0708000000"
          />
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Numéro du gérant/propriétaire à notifier par WhatsApp depuis Stock quand des produits passent
          sous leur seuil d'alerte — laisser vide pour désactiver le bouton de notification.
        </p>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={taxEnabled} onChange={(e) => setTaxEnabled(e.target.checked)} />
          Appliquer la TVA
        </label>
        {taxEnabled && (
          <label style={{ marginLeft: 24 }}>
            Taux de TVA par défaut (%)
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
          Les prix saisis (produits, lignes de vente) sont toujours des prix TTC — le taux ne les
          augmente pas, il sert uniquement à afficher le montant de TVA inclus sur les reçus, devis et
          tickets de service (ligne "dont TVA"). Un produit peut avoir son propre taux dans sa fiche,
          sinon ce taux par défaut s'applique.
        </p>

        <div>
          <strong style={{ fontSize: 14 }}>Logo</strong>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
            {logoDataUrl && (
              <img
                src={logoDataUrl}
                alt="Logo de l'entreprise"
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
                Supprimer le logo
              </button>
            )}
          </div>
          {logoError && (
            <p style={{ color: "#f87171", fontSize: 13 }}>{logoError}</p>
          )}
        </div>

        <label>
          Format du ticket de caisse
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
            <option value="custom">Personnalisé (nombre de caractères)</option>
          </select>
        </label>
        {receiptPreset === "custom" && (
          <label>
            Caractères par ligne
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
        <strong>Modules actifs</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Détermine les onglets visibles dans le menu — un pressing n'a par exemple besoin que de
          "Tickets de service", pas de Ventes/Produits/Stock.
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={enableSales} onChange={(e) => setEnableSales(e.target.checked)} />
          Ventes au comptoir
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enableProducts}
            onChange={(e) => setEnableProducts(e.target.checked)}
          />
          Catalogue produits
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={enableStock} onChange={(e) => setEnableStock(e.target.checked)} />
          Gestion de stock
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enableSuppliers}
            onChange={(e) => setEnableSuppliers(e.target.checked)}
          />
          Fournisseurs
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enablePurchases}
            onChange={(e) => setEnablePurchases(e.target.checked)}
          />
          Achats
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enableServiceOrders}
            onChange={(e) => setEnableServiceOrders(e.target.checked)}
          />
          Tickets de service (dépôt/retrait différé — pressing, cordonnerie, couture, réparation...)
        </label>
        {enableServiceOrders && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 24 }}>
            <input
              type="checkbox"
              checked={printPromisedDateOnTicket}
              onChange={(e) => setPrintPromisedDateOnTicket(e.target.checked)}
            />
            Imprimer la date de retrait prévue sur le ticket
          </label>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enablePromotions}
            onChange={(e) => setEnablePromotions(e.target.checked)}
          />
          Remises programmées (promotions appliquées automatiquement aux ventes)
        </label>
      </div>

      <div style={cardStyle}>
        <strong>Multi-boutique</strong>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={multiStoreEnabled}
            onChange={(e) => setMultiStoreEnabled(e.target.checked)}
          />
          Activer plusieurs boutiques (succursales)
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Chaque boutique a son propre stock et ses propres ventes, dans la même base de données —
          un sélecteur de boutique apparaît dans le menu du haut une fois activé et au moins deux
          boutiques créées.
        </p>
        {multiStoreEnabled && <StoresSection />}
      </div>

      <div style={cardStyle}>
        <strong>Export comptable SYSCOHADA</strong>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enableSyscohada}
            onChange={(e) => setEnableSyscohada(e.target.checked)}
          />
          Activer l&apos;onglet Export SYSCOHADA (Comptabilité)
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Journaux et balance générale au format SYSCOHADA (OHADA, zone UEMOA/CFA), à destination d&apos;un
          cabinet comptable. Base de départ non validée pour ce commerce précis — voir l&apos;avertissement
          dans l&apos;onglet une fois activé.
        </p>
        {enableSyscohada && <SyscohadaAccountsSection />}
      </div>

      <div style={cardStyle}>
        <strong>Points de fidélité</strong>
        <label>
          Points gagnés par unité de devise dépensée
          <input
            style={inputStyle}
            type="number"
            step="0.001"
            min="0"
            value={loyaltyPointsRatio}
            onChange={(e) => setLoyaltyPointsRatio(e.target.value)}
          />
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Ex : 0.1 = 1 point gagné tous les 10 [devise] dépensés. La valeur de rachat d'un point est
          l'inverse exact de ce taux. Mettre à 0 désactive le programme de fidélité.
        </p>

        <strong style={{ marginTop: 16, display: "block" }}>Paliers (Bronze / Argent / Or)</strong>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>
            Seuil Argent (points cumulés à vie)
            <input
              style={inputStyle}
              type="number"
              min="0"
              value={loyaltyTierSilverThreshold}
              onChange={(e) => setLoyaltyTierSilverThreshold(e.target.value)}
            />
          </label>
          <label>
            Seuil Or (points cumulés à vie)
            <input
              style={inputStyle}
              type="number"
              min="0"
              value={loyaltyTierGoldThreshold}
              onChange={(e) => setLoyaltyTierGoldThreshold(e.target.value)}
            />
          </label>
          <label>
            Multiplicateur Argent
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
            Multiplicateur Or
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
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Bronze est le palier de base (multiplicateur 1×, sans seuil). Un client passe Argent/Or dès
          que son cumul de points à vie (jamais réduit par un rachat) dépasse ces seuils, et gagne
          alors ses points au taux ci-dessus multiplié par le multiplicateur de son palier.
        </p>
      </div>

      <div style={cardStyle}>
        <strong>Sécurité</strong>
        <label>
          Verrouillage automatique après inactivité (minutes, 0 = désactivé)
          <input
            style={inputStyle}
            type="number"
            min="0"
            value={autoLockMinutes}
            onChange={(e) => setAutoLockMinutes(e.target.value)}
          />
        </label>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Retourne automatiquement à l'écran de code PIN après ce délai sans activité — utile pour un
          poste laissé sans surveillance. Nécessite qu'un code PIN soit défini pour l'utilisateur, sinon
          seule une reconnexion complète permet de reprendre la session.
        </p>
      </div>

      <div style={cardStyle}>
        <strong>Sauvegardes</strong>

        <label>
          Fréquence
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
            <option value="custom">Personnalisée (nombre de jours)</option>
          </select>
        </label>
        {frequencyPreset === "custom" && (
          <label>
            Délai en jours
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
          <strong style={{ fontSize: 14 }}>Sauvegarde locale</strong>
          {isFileSystemAccessSupported() ? (
            <>
              <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                Dossier actuel : {folderName ?? "aucun dossier choisi"}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14 }}
                  onClick={handlePickFolder}
                >
                  Choisir un dossier
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
                  {runningLocal ? "Sauvegarde..." : "Sauvegarder maintenant"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ color: "#fdba74", fontSize: 13 }}>
                Ce navigateur ne prend pas en charge la sauvegarde automatique dans un dossier. Tu peux
                quand même télécharger une sauvegarde manuellement à tout moment.
              </p>
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
                {downloadingBackup ? "Téléchargement..." : "Télécharger une sauvegarde maintenant"}
              </button>
              {downloadBackupError && (
                <p style={{ color: "#f87171", fontSize: 13 }}>{downloadBackupError}</p>
              )}
            </>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
          <strong style={{ fontSize: 14 }}>Importer une sauvegarde</strong>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
            Restaure les données depuis un fichier .sqlite3 (sauvegarde locale, Google Drive téléchargée,
            ou export manuel).
          </p>
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
            {importing ? "Import..." : "Importer une sauvegarde"}
            <input
              type="file"
              accept=".sqlite3"
              onChange={handleImportBackup}
              disabled={importing}
              style={{ display: "none" }}
            />
          </label>
          {importError && <p style={{ color: "#f87171", fontSize: 13 }}>{importError}</p>}
          {importInfo && <p style={{ color: "#86efac", fontSize: 13 }}>{importInfo}</p>}
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
          <strong style={{ fontSize: 14 }}>Google Drive</strong>
          <label>
            Client ID Google
            <input
              style={inputStyle}
              value={googleDriveClientId}
              onChange={(e) => setGoogleDriveClientId(e.target.value)}
              placeholder="xxxxxxxxxxxx.apps.googleusercontent.com"
            />
          </label>
          <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
            Nécessite un Client ID OAuth créé dans Google Cloud Console (accès limité aux fichiers créés
            par l'app).
          </p>
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
            {runningDrive ? "Connexion..." : "Se connecter et sauvegarder maintenant"}
          </button>
        </div>

        {backupError && <p style={{ color: "#f87171" }}>{backupError}</p>}

        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Date</th>
              <th style={thStyle}>Destination</th>
              <th style={thStyle}>Statut</th>
              <th style={thStyle}>Détail</th>
            </tr>
          </thead>
          <tbody>
            {backups.slice(0, 10).map((b) => (
              <tr key={b.id}>
                <td style={tdStyle}>{b.createdAt}</td>
                <td style={tdStyle}>{DESTINATION_LABELS[b.destination as BackupDestination] ?? b.destination}</td>
                <td style={tdStyle}>
                  <span style={badgeStyle(b.status === "success" ? "ok" : "warning")}>
                    {b.status === "success" ? "Réussie" : "Échec"}
                  </span>
                </td>
                <td style={tdStyle}>{b.fileRef ?? "—"}</td>
              </tr>
            ))}
            {backups.length === 0 && (
              <tr>
                <td style={tdStyle} colSpan={4}>
                  Aucune sauvegarde pour le moment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={cardStyle}>
        <strong>Maintenance</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          Code séparé des comptes utilisateurs, utilisé pour autoriser les actions de maintenance
          (installation d'une mise à jour) — utile si l'installateur n'a pas le mot de passe Admin du
          client.
        </p>
        {maintenanceCodeSet && (
          <label>
            Code de maintenance actuel
            <input
              style={inputStyle}
              type="password"
              value={currentMaintenanceCode}
              onChange={(e) => setCurrentMaintenanceCode(e.target.value)}
            />
          </label>
        )}
        <label>
          {maintenanceCodeSet ? "Nouveau code" : "Définir le code de maintenance"}
          <input
            style={inputStyle}
            type="password"
            value={newMaintenanceCode}
            onChange={(e) => setNewMaintenanceCode(e.target.value)}
            placeholder="Au moins 6 caractères"
          />
        </label>
        {maintenanceCodeError && <p style={{ color: "#f87171", fontSize: 13 }}>{maintenanceCodeError}</p>}
        {maintenanceCodeSaved && <p style={{ color: "#86efac", fontSize: 13 }}>Code enregistré.</p>}
        <button
          style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14, alignSelf: "flex-start" }}
          onClick={handleSaveMaintenanceCode}
          disabled={savingMaintenanceCode || !newMaintenanceCode}
        >
          {savingMaintenanceCode ? "Enregistrement..." : "Enregistrer le code"}
        </button>

        {isTauriRuntime() && (
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
            <strong style={{ fontSize: 14 }}>Installer une mise à jour</strong>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
              Choisis le fichier d'installation (.exe/.msi) apporté, saisis le code de maintenance —
              l'app tente une sauvegarde locale automatique (si un dossier de sauvegarde est configuré
              ci-dessus), puis lance l'installeur. La sauvegarde n'est pas bloquante : si elle échoue,
              l'installation continue quand même avec un avertissement. WariBox ne se ferme plus
              automatiquement : tu contrôles toi-même le moment de la fermeture, une fois l'installeur
              visible à l'écran.
            </p>
            <p style={{ color: "#facc15", fontSize: 13 }}>
              L'installeur n'est pas signé numériquement. Si Windows affiche un écran bleu
              &quot;Windows a protégé votre PC&quot; (SmartScreen), c'est normal — clique sur
              &quot;Informations complémentaires&quot; puis &quot;Exécuter quand même&quot;. Si cet écran
              apparaît en arrière-plan sans que tu le remarques et que WariBox se ferme avant, la mise à
              jour semble ne rien faire : c'est exactement pour éviter ça que la fermeture est maintenant
              manuelle. Préfère aussi le fichier <strong>.exe</strong> au <strong>.msi</strong> quand les
              deux sont disponibles : il s'installe par utilisateur, sans invite d'autorisation Windows
              (UAC) supplémentaire.
            </p>
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
                {updateFilePath ? "Changer de fichier" : "Choisir le fichier d'installation"}
              </button>
              {updateFilePath && <span style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{updateFilePath}</span>}
            </div>
            <label>
              Code de maintenance
              <input
                style={inputStyle}
                type="password"
                value={updateCode}
                onChange={(e) => setUpdateCode(e.target.value)}
              />
            </label>
            {updateStep && <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>{updateStep}</p>}
            {updateError && <p style={{ color: "#f87171", fontSize: 13 }}>{updateError}</p>}
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
                L'installeur est ouvert — fermer WariBox maintenant
              </button>
            ) : (
              <button
                style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14, alignSelf: "flex-start" }}
                onClick={handleInstallUpdate}
                disabled={updating || !maintenanceCodeSet}
                title={!maintenanceCodeSet ? "Définis d'abord un code de maintenance" : undefined}
              >
                {updating ? "Installation..." : "Lancer l'installeur"}
              </button>
            )}
          </div>
        )}
      </div>

      {error && <p style={{ color: "#f87171" }}>{error}</p>}
      {saved && <p style={{ color: "#86efac" }}>Enregistré.</p>}

      <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
        {saving ? "Enregistrement..." : "Enregistrer"}
      </button>
    </main>
  );
}
