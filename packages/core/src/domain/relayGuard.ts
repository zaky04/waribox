import { t } from "@gestion-boutique/i18n";

// Un appareil relié à un Maître ne modifie ni le catalogue ni certaines opérations : le Maître fait foi.
//
// - « catalog » : produits, prix, clients, fournisseurs, utilisateurs, rôles, boutiques, promotions,
//   réglages... Le Maître renvoie périodiquement ces tables à l'appareil relié (voir sync/snapshot.ts) ;
//   une modification faite ici serait écrasée, et deux produits créés chacun de leur côté recevraient le
//   même identifiant local.
// - « operation » : achats, remboursements, inventaires, rebut, correction de dépenses, points de fidélité
//   manuels. Elles ne sont pas encore répliquées vers le Maître ; or le stock de l'appareil relié est
//   réaligné sur celui du Maître, donc leur effet serait annulé au prochain alignement.
//
// L'appareil se déclare relié au démarrage de l'application (setRelayDevice) ; en mode Solo ou Maître le
// drapeau reste faux et rien ne change. Contrôle côté service : l'interface n'est qu'un confort.

// Réglages propres à CET appareil : modifiables même relié, jamais écrasés par le Maître.
export const DEVICE_LOCAL_SETTINGS = ["backupFrequency", "googleDriveClientId", "receiptColumns"] as const;

let relay = false;

export function setRelayDevice(isRelay: boolean): void {
  relay = isRelay;
}

export function isRelayDevice(): boolean {
  return relay;
}

export class MasterOnlyError extends Error {
  constructor(kind: "catalog" | "operation") {
    super(t(kind === "catalog" ? "coreErrors.network.masterOnlyCatalog" : "coreErrors.network.masterOnlyOperation"));
    this.name = "MasterOnlyError";
  }
}

/** Lève une erreur claire si cet appareil est relié à un Maître. À placer en tête des fonctions concernées. */
export function assertMasterOnly(kind: "catalog" | "operation"): void {
  if (relay) throw new MasterOnlyError(kind);
}
