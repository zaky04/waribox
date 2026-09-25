import {
  emitFneQueued,
  FNE_TEST_BASE_URL,
  getSettings,
  hasMaintenanceCode,
  listBackups,
  listPendingFneCertifications,
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
import { SECTOR_OPTIONS } from "./sectorTypes";
import { APPEARANCE_PRESETS, DEFAULT_ACCENT_COLOR } from "./appearancePresets";
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
import { applyAppearance } from "../../lib/appearance";
import { saveGeneratedFile } from "../../lib/saveFile";
import { useAuth } from "../auth/useAuth";
import { useThemeStore } from "../../stores/theme";
import { certifyInvoice, FneApiError, resolveFneBaseUrl } from "../fne/fneHttp";
import { NetworkSection } from "../network/NetworkSection";
import type { AppearanceOptions } from "../../lib/appearance";
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

const BACKGROUND_OPTIONS: { value: string | null; labelKey: string; fontFamily?: string }[] = [
  { value: null, labelKey: "settings.appearance.bgPaper" },
  { value: "white", labelKey: "settings.appearance.bgWhite" },
  { value: "grey", labelKey: "settings.appearance.bgGrey" },
];
const FONT_OPTIONS: { value: string | null; labelKey: string; fontFamily?: string }[] = [
  { value: null, labelKey: "settings.appearance.fontDefault" },
  { value: "system", labelKey: "settings.appearance.fontSystem", fontFamily: "system-ui, sans-serif" },
  { value: "serif", labelKey: "settings.appearance.fontSerif", fontFamily: "Georgia, serif" },
];

export type SettingsSection = "config" | "appearance" | "advanced";

export function SettingsPage({ section = "config" }: { section?: SettingsSection }) {
  // Une seule page/un seul état/un seul bouton Enregistrer, trois vues : les blocs
  // hors-section restent montés (display: none) pour ne perdre aucune saisie.
  const vis = (name: SettingsSection): React.CSSProperties => ({ display: section === name ? "contents" : "none" });
  const db = useDatabase();
  const { user } = useAuth();
  const { t } = useTranslation();
  const theme = useThemeStore((s) => s.theme);

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
  const [sectorType, setSectorType] = useState("");
  // null = thème par défaut (aucune personnalisation) — voir lib/appearance.ts.
  const [appearanceAccentColor, setAppearanceAccentColor] = useState<string | null>(null);
  const [appearanceShape, setAppearanceShape] = useState<string | null>(null);
  const [appearanceBackground, setAppearanceBackground] = useState<string | null>(null);
  const [appearanceFont, setAppearanceFont] = useState<string | null>(null);
  // Aperçu immédiat (avant Enregistrer) : on repasse tout l'état courant, seul
  // le champ modifié change.
  const previewAppearance = (o: Partial<AppearanceOptions>) =>
    applyAppearance(
      { accent: appearanceAccentColor, shape: appearanceShape, background: appearanceBackground, font: appearanceFont, ...o },
      theme,
    );
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

  const [fneEnabled, setFneEnabled] = useState(false);
  const [fneEnvironment, setFneEnvironment] = useState<"test" | "prod">("test");
  const [fneApiKey, setFneApiKey] = useState("");
  const [fneApiBaseUrl, setFneApiBaseUrl] = useState("");
  const [fneEstablishment, setFneEstablishment] = useState("");
  const [fnePointOfSale, setFnePointOfSale] = useState("");
  const [fneTesting, setFneTesting] = useState(false);
  const [fneTestResult, setFneTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [fnePendingCount, setFnePendingCount] = useState(0);

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
  // Menu Modules protégé par le code de maintenance (vendeur/support) : le
  // verrou vaut pour la visite en cours seulement (la page est remontée à
  // chaque changement de menu). Sans code défini, l'accès reste libre (bases
  // existantes) avec un rappel.
  const [codeChecked, setCodeChecked] = useState(false);
  const [modulesUnlocked, setModulesUnlocked] = useState(false);
  const [gateCode, setGateCode] = useState("");
  // Gardé en mémoire (jamais stocké) pour le joindre à l'enregistrement : le
  // service exige la preuve du code pour modifier les réglages avancés.
  const [unlockedCode, setUnlockedCode] = useState<string | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const handleUnlockModules = async () => {
    setGateError(null);
    try {
      if (await verifyMaintenanceCode(db, gateCode.trim())) {
        setModulesUnlocked(true);
        setUnlockedCode(gateCode.trim());
        setGateCode("");
      } else {
        setGateError(t("settings.modulesGate.wrong"));
      }
    } catch (err) {
      setGateError(describeError(err, t("settings.modulesGate.wrong")));
    }
  };
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
    setCodeChecked(true);
    setLoyaltyPointsRatio(String(settings.loyaltyPointsRatio));
    setLoyaltyTierSilverThreshold(String(settings.loyaltyTierSilverThreshold));
    setLoyaltyTierGoldThreshold(String(settings.loyaltyTierGoldThreshold));
    setLoyaltyTierSilverMultiplier(String(settings.loyaltyTierSilverMultiplier));
    setLoyaltyTierGoldMultiplier(String(settings.loyaltyTierGoldMultiplier));
    setGoogleDriveClientId(settings.googleDriveClientId ?? "");
    setBackups(backupRows);
    setFolderName(handle?.name ?? null);

    setBusinessName(settings.businessName ?? "");
    setSectorType(settings.sectorType ?? "");
    setAppearanceAccentColor(settings.appearanceAccentColor ?? null);
    setAppearanceShape(settings.appearanceShape ?? null);
    setAppearanceBackground(settings.appearanceBackground ?? null);
    setAppearanceFont(settings.appearanceFont ?? null);
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

    setFneEnabled(settings.fneEnabled);
    setFneEnvironment(settings.fneEnvironment === "prod" ? "prod" : "test");
    setFneApiKey(settings.fneApiKey ?? "");
    setFneApiBaseUrl(settings.fneApiBaseUrl ?? "");
    setFneEstablishment(settings.fneEstablishment ?? "");
    setFnePointOfSale(settings.fnePointOfSale ?? "");
    setFnePendingCount((await listPendingFneCertifications(db)).length);

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
          // Pas de `|| undefined` ici, contrairement aux autres champs texte
          // de cette section : une valeur vide est un choix valide ("Aucun
          // (thème par défaut)", voir sectorTypes.ts) qui doit pouvoir
          // écraser un secteur précédemment choisi, pas être ignorée comme
          // un champ non renseigné.
          sectorType: sectorType,
          appearanceAccentColor,
          appearanceShape,
          appearanceBackground,
          appearanceFont,
          advancedCode: unlockedCode ?? undefined,
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
          fneEnabled,
          fneEnvironment,
          fneApiKey: fneApiKey.trim() || undefined,
          fneApiBaseUrl: fneApiBaseUrl.trim() || undefined,
          fneEstablishment: fneEstablishment.trim() || undefined,
          fnePointOfSale: fnePointOfSale.trim() || undefined,
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
      // Le code qu'on vient de définir déverrouille la visite en cours (sinon l'écran
      // se reverrouillerait aussitôt) et sert de preuve pour l'enregistrement.
      setModulesUnlocked(true);
      setUnlockedCode(newMaintenanceCode);
      setCurrentMaintenanceCode("");
      setNewMaintenanceCode("");
      setMaintenanceCodeSaved(true);
    } catch (err) {
      setMaintenanceCodeError(describeError(err, t("settings.errors.maintenanceCode")));
    } finally {
      setSavingMaintenanceCode(false);
    }
  };

  // Teste la connexion avec les valeurs actuellement saisies (pas
  // nécessairement enregistrées) — un payload minimal factice suffit :
  // même une erreur 401 (mauvaise clé) renvoyée par le vrai serveur FNE
  // prouve que l'URL/l'endpoint/le format d'authentification déduits du
  // SDK tiers sont corrects (voir CLAUDE.md). Une erreur réseau/CORS,
  // elle, indique un problème de plomberie plutôt que de clé.
  const handleTestFneConnection = async () => {
    setFneTestResult(null);
    setFneTesting(true);
    try {
      const baseUrl = resolveFneBaseUrl(fneEnvironment, fneApiBaseUrl.trim() || null);
      if (!baseUrl) {
        setFneTestResult({ success: false, message: t("settings.errors.fneMissingBaseUrl") });
        return;
      }
      await certifyInvoice(
        {
          invoiceType: "sale",
          paymentMethod: "cash",
          template: "B2C",
          pointOfSale: fnePointOfSale.trim() || "TEST",
          establishment: fneEstablishment.trim() || "TEST",
          clientCompanyName: t("settings.fne.testClientName"),
          clientPhone: "0000000000",
          clientEmail: "test@example.com",
          isRne: false,
          items: [{ description: t("settings.fne.testItemDescription"), quantity: 1, amount: 100, taxes: ["TVA"] }],
          foreignCurrency: "",
          foreignCurrencyRate: 0,
        },
        { apiKey: fneApiKey.trim(), baseUrl },
      );
      setFneTestResult({ success: true, message: t("settings.fne.testSuccess") });
    } catch (err) {
      const message = err instanceof FneApiError ? err.message : describeError(err, t("settings.fne.testFailure"));
      // Une vraie réponse HTTP du serveur (même une erreur) vaut mieux
      // qu'un silence — voir le commentaire au-dessus de cette fonction.
      const reachedServer = err instanceof FneApiError && err.statusCode !== null;
      setFneTestResult({ success: false, message: reachedServer ? `${t("settings.fne.testServerReached")} ${message}` : message });
    } finally {
      setFneTesting(false);
    }
  };

  // Relance immédiatement le traitement de la file d'attente (voir
  // useFneQueue.ts, monté globalement dans App.tsx) plutôt que de dupliquer
  // ici la logique de certification — cette page ne fait que déclencher
  // l'événement déjà écouté par le hook, puis rafraîchit le compteur après
  // un court délai pour lui laisser le temps de tourner.
  const handleRetryFneNow = () => {
    emitFneQueued();
    setTimeout(() => {
      void listPendingFneCertifications(db).then((rows) => setFnePendingCount(rows.length));
    }, 2000);
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

  if (section === "advanced" && (!codeChecked || (maintenanceCodeSet && !modulesUnlocked))) {
    return (
      <main style={pageStyle}>
        <h1>{t("nav.advanced")}</h1>
        {codeChecked && (
          <div style={cardStyle}>
            <strong>{t("settings.modulesGate.title")}</strong>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.modulesGate.hint")}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleUnlockModules();
              }}
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <label>
                {t("settings.modulesGate.codeLabel")}
                <input
                  style={inputStyle}
                  type="password"
                  autoComplete="off"
                  value={gateCode}
                  onChange={(e) => setGateCode(e.target.value)}
                />
              </label>
              {gateError && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{gateError}</p>}
              <button style={primaryButtonStyle} type="submit" disabled={!gateCode.trim()}>
                {t("settings.modulesGate.unlock")}
              </button>
            </form>
          </div>
        )}
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <h1>{t(section === "appearance" ? "nav.appearance" : section === "advanced" ? "nav.advanced" : "settings.title")}</h1>

      <div style={vis("config")}>
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

      </div>

      <div style={vis("appearance")}>
      <div style={cardStyle}>
        <strong>{t("settings.appearance.heading")}</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>
          {t("settings.appearance.hint")}
        </p>
        <label>
          {t("settings.business.sectorType")}
          <select style={inputStyle} value={sectorType} onChange={(e) => setSectorType(e.target.value)}>
            <option value="">{t("settings.business.sectorNone")}</option>
            {SECTOR_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12.5, color: "var(--color-text-muted)", marginTop: 4 }}>
            {t("settings.business.sectorTypeHint")}
          </div>
        </label>


        <div>
          <strong style={{ fontSize: 14 }}>{t("settings.appearance.accentColor")}</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
            <button
              type="button"
              title={t("settings.appearance.default")}
              onClick={() => {
                setAppearanceAccentColor(null);
                previewAppearance({ accent: null });
              }}
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                cursor: "pointer",
                background: DEFAULT_ACCENT_COLOR,
                border:
                  appearanceAccentColor === null
                    ? "3px solid var(--color-text)"
                    : "1px solid var(--color-border)",
                position: "relative",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontSize: 16,
                  lineHeight: 1,
                }}
              >
                ×
              </span>
            </button>
            {APPEARANCE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                title={t(preset.labelKey)}
                onClick={() => {
                  setAppearanceAccentColor(preset.color);
                  previewAppearance({ accent: preset.color });
                }}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  cursor: "pointer",
                  background: preset.color,
                  border:
                    appearanceAccentColor === preset.color
                      ? "3px solid var(--color-text)"
                      : "1px solid var(--color-border)",
                }}
              />
            ))}
            <label
              title={t("settings.appearance.custom")}
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                cursor: "pointer",
                overflow: "hidden",
                border:
                  appearanceAccentColor !== null &&
                  !APPEARANCE_PRESETS.some((p) => p.color === appearanceAccentColor)
                    ? "3px solid var(--color-text)"
                    : "1px solid var(--color-border)",
                display: "flex",
              }}
            >
              <input
                type="color"
                value={appearanceAccentColor ?? DEFAULT_ACCENT_COLOR}
                onChange={(e) => {
                  setAppearanceAccentColor(e.target.value);
                  previewAppearance({ accent: e.target.value });
                }}
                style={{
                  width: 48,
                  height: 48,
                  marginLeft: -6,
                  marginTop: -6,
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
              />
            </label>
          </div>
        </div>

        <div>
          <strong style={{ fontSize: 14 }}>{t("settings.appearance.shape")}</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {(["standard", "round", "square"] as const).map((shapeOption) => {
              const value = shapeOption === "standard" ? null : shapeOption;
              const radius = shapeOption === "round" ? 14 : shapeOption === "square" ? 2 : 6;
              return (
                <button
                  key={shapeOption}
                  type="button"
                  onClick={() => {
                    setAppearanceShape(value);
                    previewAppearance({ shape: value });
                  }}
                  style={{
                    padding: "8px 16px",
                    borderRadius: radius,
                    border:
                      (appearanceShape ?? "standard") === shapeOption
                        ? "2px solid var(--color-accent)"
                        : "1px solid var(--color-border)",
                    background: "var(--color-bg)",
                    color: "var(--color-text)",
                    cursor: "pointer",
                  }}
                >
                  {shapeOption === "standard"
                    ? t("settings.appearance.shapeStandard")
                    : shapeOption === "round"
                      ? t("settings.appearance.shapeRounded")
                      : t("settings.appearance.shapeSquare")}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <strong style={{ fontSize: 14 }}>{t("settings.appearance.background")}</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
            {BACKGROUND_OPTIONS.map((opt) => (
              <button
                key={opt.value ?? "default"}
                type="button"
                onClick={() => {
                  setAppearanceBackground(opt.value);
                  previewAppearance({ background: opt.value });
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: "var(--radius-md)",
                  border: appearanceBackground === opt.value ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  fontFamily: opt.fontFamily,
                  cursor: "pointer",
                }}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <strong style={{ fontSize: 14 }}>{t("settings.appearance.font")}</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
            {FONT_OPTIONS.map((opt) => (
              <button
                key={opt.value ?? "default"}
                type="button"
                onClick={() => {
                  setAppearanceFont(opt.value);
                  previewAppearance({ font: opt.value });
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: "var(--radius-md)",
                  border: appearanceFont === opt.value ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  fontFamily: opt.fontFamily,
                  cursor: "pointer",
                }}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      </div>

      <div style={vis("advanced")}>
      {section === "advanced" && !maintenanceCodeSet && (
        <p style={{ color: "var(--color-warning)", fontSize: 13, margin: 0 }}>{t("settings.modulesGate.noCodeBanner")}</p>
      )}
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

      </div>

      <div style={vis("advanced")}>
      <div style={cardStyle}>
        <NetworkSection />
      </div>

      </div>

      <div style={vis("config")}>
      <div style={cardStyle}>
        <strong>{t("settings.fne.heading")}</strong>
        <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: 0 }}>{t("settings.fne.hint")}</p>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={fneEnabled} onChange={(e) => setFneEnabled(e.target.checked)} />
          {t("settings.fne.enable")}
        </label>
        {fneEnabled && (
          <>
            <label>
              {t("settings.fne.environment")}
              <select
                style={inputStyle}
                value={fneEnvironment}
                onChange={(e) => setFneEnvironment(e.target.value === "prod" ? "prod" : "test")}
              >
                <option value="test">{t("settings.fne.environmentTest")}</option>
                <option value="prod">{t("settings.fne.environmentProd")}</option>
              </select>
            </label>
            {fneEnvironment === "prod" && (
              <label>
                {t("settings.fne.baseUrl")}
                <input
                  style={inputStyle}
                  value={fneApiBaseUrl}
                  onChange={(e) => setFneApiBaseUrl(e.target.value)}
                  placeholder="https://..."
                />
              </label>
            )}
            <label>
              {t("settings.fne.apiKey")}
              <input style={inputStyle} type="password" value={fneApiKey} onChange={(e) => setFneApiKey(e.target.value)} />
            </label>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <label style={{ flex: 1, minWidth: 160 }}>
                {t("settings.fne.establishment")}
                <input style={inputStyle} value={fneEstablishment} onChange={(e) => setFneEstablishment(e.target.value)} />
              </label>
              <label style={{ flex: 1, minWidth: 160 }}>
                {t("settings.fne.pointOfSale")}
                <input style={inputStyle} value={fnePointOfSale} onChange={(e) => setFnePointOfSale(e.target.value)} />
              </label>
            </div>
            <p style={{ color: "var(--color-text-muted)", fontSize: 12, margin: 0 }}>
              {fneEnvironment === "test" ? `${t("settings.fne.testUrlHint")} ${FNE_TEST_BASE_URL}` : t("settings.fne.prodUrlHint")}
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <button
                style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                onClick={handleTestFneConnection}
                disabled={fneTesting || !fneApiKey.trim()}
              >
                {fneTesting ? t("settings.fne.testing") : t("settings.fne.testConnection")}
              </button>
              {fnePendingCount > 0 && (
                <button
                  style={{ ...primaryButtonStyle, padding: "8px 14px", fontSize: 14, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                  onClick={handleRetryFneNow}
                >
                  {t("settings.fne.retryNow", { count: fnePendingCount })}
                </button>
              )}
            </div>
            {fneTestResult && (
              <p style={{ color: fneTestResult.success ? "var(--color-success)" : "var(--color-danger)", fontSize: 13 }}>
                {fneTestResult.message}
              </p>
            )}
          </>
        )}
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

      </div>

      <div style={vis("config")}>
      <div style={cardStyle}>
        <strong>{t("settings.promotionsCard.heading")}</strong>
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

      </div>

      <div style={vis("config")}>
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

      </div>

      <div style={vis("advanced")}>
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
            <p style={{ color: "var(--color-text-muted)", fontSize: 13, margin: "0 0 8px" }}>
              {t("settings.maintenance.currentVersion", { version: __APP_VERSION__ })}
            </p>
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

      </div>

      {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}
      {saved && <p style={{ color: "var(--color-success)" }}>{t("settings.saved")}</p>}

      <button style={primaryButtonStyle} onClick={handleSubmit} disabled={saving}>
        {saving ? t("settings.saving") : t("settings.save")}
      </button>
    </main>
  );
}
