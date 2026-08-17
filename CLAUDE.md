# WariBox — notes de suivi du projet

Application de gestion de commerce (POS) **offline-first** pour petits commerces.
Ce fichier est le point d'entrée pour tout dev ou toute IA qui reprend le projet :
il documente l'architecture réelle (vérifiée, pas supposée), les conventions
métier importantes, et un journal daté des décisions/travaux pour garder le fil
d'une session à l'autre. À tenir à jour à chaque changement structurant —
ne pas laisser dériver.

## Objectif de l'application

Gestion de commerce pour commerçants (souvent non-techniques), utilisable
**sans connexion internet** : ventes au comptoir, stock, clients/fournisseurs,
comptabilité simplifiée (référentiel SYSCOHADA, Afrique de l'Ouest). Tout tourne
en local sur l'appareil du commerçant — aucune donnée n'est envoyée à un
serveur (sauf sauvegarde optionnelle vers Google Drive ou un dossier local).

## Stack technique

- **Monorepo** : pnpm workspaces + Turborepo, TypeScript de bout en bout
- **Frontend** : React 18 + Vite 6 + Zustand — [apps/web](apps/web)
- **Desktop** : Tauri 2 (Rust), embarque le frontend web — [apps/desktop](apps/desktop)
- **Base de données** : SQLite en local, exécutée dans un **Web Worker** avec le
  VFS OPFS SAH-pool ([packages/database/src/sahpool-worker.js](packages/database/src/sahpool-worker.js)),
  pilotée via **Drizzle ORM** (`drizzle-orm/sqlite-proxy`). Pas de backend/API
  distante — le "serveur" c'est le worker du navigateur.
- Impression tickets ESC/POS + PDF ([packages/printer](packages/printer)), exports
  Excel/PDF ([packages/reports](packages/reports)), scan code-barres caméra (`@zxing/browser`)

## Structure du monorepo

```
apps/web            → SPA React/Vite (PWA), le cœur applicatif
apps/desktop         → wrapper Tauri autour de apps/web
packages/database    → schéma Drizzle (packages/database/src/schema/*.ts) + bootstrap SQL + client worker
packages/core        → toute la logique métier, 1 fichier services/*Service.ts par domaine
packages/printer      → tickets ESC/POS, étiquettes PDF
packages/reports      → export Excel/PDF
packages/sync         → sauvegarde (Google Drive, dossier local)
packages/maintenance-cli → CLI de maintenance
```

`apps/web/src/features/` : un dossier par module métier (ventes, stock, clients,
promotions, etc.), miroir des services de `packages/core`.

## Conventions métier importantes (à connaître avant de toucher au code)

- **Prix TTC partout** : les prix saisis/affichés incluent déjà la taxe. Le taux
  ne sert qu'à *extraire* la TVA contenue (`gross * taux/(100+taux)`), jamais à
  l'ajouter par-dessus. Voir `computeTaxAmount` dans
  [SalesService.ts](packages/core/src/services/SalesService.ts).
- **FEFO, pas FIFO** : malgré le nom des commits ("FIFO lot tracking"), la
  consommation de stock ([StockService.consumeStockFefo](packages/core/src/services/StockService.ts:261))
  suit l'ordre de **péremption la plus proche d'abord** (FEFO), pas l'ordre
  d'entrée en stock.
- **Solde de stock jamais stocké** : toujours recalculé depuis le grand livre
  `stock_movements` (`SUM(quantity_delta)`), comme en comptabilité. Idem pour
  le solde par lot (`stock_batches`).
- **Fidélité à paliers (Bronze/Argent/Or)** : basés sur le cumul de points **à
  vie** (`lifetime_loyalty_points`), jamais décrémenté par un rachat de points
  — sinon un client perdrait son palier en dépensant ses points. Voir
  [LoyaltyService.ts](packages/core/src/services/LoyaltyService.ts).
- **Permissions** : liste centralisée dans
  [permissions.ts](packages/core/src/domain/permissions.ts), vérifiée à la fois
  côté UI (affichage) et côté service (`requirePermission`, défense en
  profondeur). `mergeMissingPermissions` rattrape automatiquement les nouvelles
  permissions sur une base déjà déployée, sans jamais en retirer.
- **Multi-boutique** : togglable (`business_settings.multiStoreEnabled`), une
  boutique par défaut existe toujours même désactivé. Gérant/Vendeur/Caissier
  restent cantonnés à leur boutique assignée ; Admin/Propriétaire voient tout.
- **Transactions maison** : `drizzle-orm/sqlite-proxy` n'a pas de support de
  transaction natif. `withTransaction()` dans
  [client.ts](packages/database/src/client.ts) envoie directement
  `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` au worker (connexion SQLite unique,
  exécution séquentielle — voir sahpool-worker.js) + un verrou pour sérialiser
  les transactions entre elles. **Toute opération métier qui lit-valide-écrit
  en plusieurs étapes doit être enveloppée dedans** (voir `createSale`,
  `createRefund` et `createPurchase` pour le modèle à suivre). Ne pas oublier
  d'envelopper toute la séquence, pas seulement les écritures — sinon la
  validation peut être contournée par une opération concurrente.
- **Coût par lot suit le lot, y compris à travers un transfert** :
  `stock_batches.unitCost` est renseigné à l'achat
  (`PurchasesService.createPurchase`, qui crée un lot par ligne achetée) et
  utilisé par `ReportsService.getMarginsSummary`/`getProductMarginsBreakdown`
  pour calculer la marge réelle (repli sur `products.purchasePrice` si lot
  inconnu). **`StockService.transferStock` doit impérativement recréer un lot
  "miroir" (même coût, même péremption) à l'emplacement de destination** —
  sans ça, le flux normal Achat → Réserve → Transfert → Surface de vente →
  Vente perd la traçabilité du coût dès le transfert, et la marge retombe
  silencieusement sur `products.purchasePrice`. Tout nouveau code qui déplace
  du stock entre emplacements doit suivre le même principe.
- **`isTauri()` ne distingue pas desktop d'Android** : les deux sont des
  runtimes Tauri, donc `@tauri-apps/api/core`'s `isTauri()` (utilisé par
  [isTauriRuntime()](apps/web/src/features/settings/tauriRuntime.ts))
  renvoie `true` dans les deux cas. **Tout code réservé au desktop
  (installeur `.exe`/`.msi`, chemins de fichiers Windows, etc.) doit utiliser
  [isDesktopTauriRuntime()](apps/web/src/features/settings/tauriRuntime.ts)**
  (détection par `navigator.userAgent` contenant `"Android"`, faute de
  `@tauri-apps/plugin-os` installé dans ce projet), pas `isTauriRuntime()`
  seul — sinon la fonctionnalité s'affiche aussi sur Android sans pouvoir y
  faire quoi que ce soit d'utile (vu en pratique sur le bloc "Installer une
  mise à jour" de Paramètres, voir journal du 2026-08-14).
- **Permission Tauri ≠ scope Tauri** : accorder une permission
  (`opener:allow-open-path`, `fs:allow-*`, etc.) dans
  [capabilities/default.json](apps/desktop/src-tauri/capabilities/default.json)
  autorise seulement l'*appel* de la commande — si cette commande manipule
  des chemins/URLs, elle vérifie *en plus* un **scope** séparé (liste de
  motifs autorisés), qui est **vide par défaut** si non précisé. Toute
  nouvelle permission de ce type doit donc être ajoutée sous sa forme objet
  avec un `"allow": [{ "path": "..." }]` (ou `"url"`) explicite, jamais comme
  simple chaîne, sous peine d'un échec silencieux type "Not allowed to open
  path ..." malgré la permission accordée (voir journal du 2026-08-14).

## Base de données / migrations

Le schéma vit dans [packages/database/src/schema/*.ts](packages/database/src/schema).
Deux mécanismes coexistent dans [client.ts](packages/database/src/client.ts),
volontairement séparés :

- **`MIGRATION_SQL` (legacy, Phase 0, gelé)** : liste brute d'`ALTER TABLE`
  rejouée en entier à chaque démarrage, erreur avalée si la colonne existe
  déjà. Conservé tel quel pour ne rien casser sur les bases existantes —
  **plus aucune nouvelle entrée ne doit y être ajoutée**.
- **`MIGRATIONS` (Phase 1, actuel)** : liste de migrations numérotées
  (`{ id, statements }`), chacune exécutée **une seule fois** (suivie dans la
  table `__migrations`), dans sa propre transaction, sans avaler d'erreur —
  une vraie faute de frappe SQL bloque désormais le démarrage au lieu d'être
  silencieusement ignorée. **Toute nouvelle évolution de schéma doit être
  ajoutée ici**, avec un `id` incrémental, jamais dans `MIGRATION_SQL`.

Le **bootstrap SQL idempotent** ([bootstrap-sql.ts](packages/database/src/bootstrap-sql.ts),
`CREATE TABLE IF NOT EXISTS`) reste la base sur laquelle ces deux listes de
migrations s'appliquent ensuite, dans cet ordre : bootstrap → `MIGRATION_SQL` →
`MIGRATIONS`.

## Internationalisation (i18n) — FR/EN

**Chantier en cours, démarré le 2026-08-15** — voir le journal de cette date
pour le détail du premier lot de pages traduites. Périmètre visé à terme :
interface **et** documents (tickets imprimés, rapports PDF/Excel), déployé
progressivement page par page plutôt qu'en un seul passage sur tout le code.

- **[packages/i18n](packages/i18n/src/index.ts)** : nouveau package —
  instance `i18next` **partagée** (pas `react-i18next` seul), avec les
  dictionnaires `src/locales/fr.json`/`en.json`. Partagée signifie : le même
  `i18next` sert à la fois à `apps/web` (via `react-i18next`,
  `useTranslation()`) **et** aux packages sans React (`core`, `printer`,
  `reports`) qui peuvent appeler `t()` directement, importé depuis
  `@gestion-boutique/i18n` — un seul `setLanguage()` met à jour tout le monde
  puisque tout tourne dans le même runtime JS (navigateur/webview Tauri).
  Pas besoin de faire transiter une langue ou une fonction `t` à travers
  chaque signature de fonction/service.
- **Langue = préférence locale à l'appareil**, pas une donnée métier :
  stockée dans `localStorage` (`waribox-language`) via
  [stores/language.ts](apps/web/src/stores/language.ts), exactement la même
  convention que [stores/theme.ts](apps/web/src/stores/theme.ts) pour le
  thème sombre/clair (voir son commentaire). Sélecteur dans
  [TopBar.tsx](apps/web/src/features/auth/TopBar.tsx), à côté du bouton de
  thème.
- **Convention de clés** : `nav.<NavTab>` pour les entrées de menu (les clés
  correspondent exactement aux valeurs de l'union `NavTab` dans
  [Nav.tsx](apps/web/src/app/Nav.tsx) — `TABS` ne stocke donc plus de
  `label` en dur, seulement `key`, pour ne jamais désynchroniser les deux).
  Sinon, une clé par page (`dashboard.*`, `topbar.*`...) — pas de
  regroupement plus fin pour l'instant vu le nombre de pages restant à
  convertir.
- **Pages traduites à ce jour** : Nav, TopBar, Dashboard (Accueil), Ventes
  (`SalesPage.tsx` + écrans d'ouverture/fermeture de caisse),
  Historique des ventes (`SalesHistoryPage.tsx`), Paramètres
  (`SettingsPage.tsx` + `StoresSection.tsx` + `SyscohadaAccountsSection.tsx`,
  les deux rendus conditionnellement dans Paramètres selon les modules
  activés), Journaux (`JournalsPage.tsx` + `RefundModal.tsx` +
  `RefundHistoryModal.tsx`, les 3 onglets Ventes/Stock/Actions), Stock
  (`StockPage.tsx`), Dépenses (`ExpensesPage.tsx`), Produits
  (`ProductsPage.tsx`), Clients (`CustomersPage.tsx`), Fournisseurs
  (`SuppliersPage.tsx`), Achats (`PurchasesPage.tsx`), Créances
  (`CreditsPage.tsx`), Dettes (`DebtsPage.tsx`), Promotions
  (`PromotionsPage.tsx`), Utilisateurs (`UsersPage.tsx`), Devis
  (`QuotesPage.tsx`), Comptabilité (`AccountingPage.tsx`, les 3 onglets
  Compte de résultat/Bilan/Export SYSCOHADA), Rapports (`ReportsPage.tsx`,
  les 6 onglets Ventes/Marges/Trésorerie/Caisse/Tickets de service/TVA),
  Tickets de service (`ServiceOrdersPage.tsx`, les 3 vues Nouveau ticket/
  Suivi/Historique — dernière page convertie, voir journal 2026-08-16), et
  le composant partagé `FilterBar`. **Toutes les pages de l'app sont
  désormais bilingues**, ainsi que tout l'écran de connexion
  ([AuthGate.tsx](apps/web/src/features/auth/AuthGate.tsx) et ses 5 écrans
  enfants — `LoginScreen`, `SetupAdminScreen`, `ModuleSetupScreen`,
  `PinLockScreen`, `ChangePasswordModal`, voir journal 2026-08-16) — le
  périmètre "Interface" est donc intégralement couvert. Sur le périmètre
  "documents"/logique métier : les **62 messages d'erreur de
  `packages/core`** (14 fichiers `services/*Service.ts` + `AuthService.ts` +
  `domain/permissions.ts`, namespace `coreErrors.*`) ainsi que
  `LoyaltyService.getTierLabel` (ex-`TIER_LABELS`) sont convertis — voir
  journal 2026-08-17. Le composant partagé `SimpleChart`
  ([components/SimpleChart.tsx](apps/web/src/components/SimpleChart.tsx),
  utilisé par Rapports pour ses graphiques, clé `common.noChartData`) et les
  **5 messages WhatsApp générés côté client**
  ([lib/whatsapp.ts](apps/web/src/lib/whatsapp.ts) pour le reçu de vente,
  Stock pour l'alerte stock bas et les péremptions proches, Créances pour la
  relance de créance en retard, Tickets de service pour l'avis de ticket
  prêt — namespace `whatsapp.*`) sont convertis aussi — voir journal
  2026-08-17. **Le contenu des documents** (`packages/printer` : reçu de
  vente ESC/POS + PDF, bon de dépôt de ticket de service ESC/POS + PDF, devis
  PDF ; `packages/reports` : les 10 rapports PDF/Excel — Ventes, Marges,
  Trésorerie, Compte de résultat, TVA, Bilan, Journal SYSCOHADA, Balance
  SYSCOHADA, Sessions de caisse) est converti aussi, namespace
  `documents.*` — voir journal 2026-08-17. Enfin, **`DEFAULT_ROLES`**
  ([permissions.ts](packages/core/src/domain/permissions.ts), les noms de
  rôle seedés "Admin"/"Propriétaire"/"Gérant"/"Vendeur"/"Caissier") est
  couvert aussi, via `getRoleDisplayName(storedName)` — le nom stocké en
  base reste en français (comparaisons d'égalité inchangées, voir
  `UsersPage.tsx`), seul l'affichage passe par une table de correspondance
  nom-stocké → clé `roles.*`, un rôle personnalisé (nom non reconnu) étant
  affiché tel quel. **Avec cette dernière pièce, le chantier bilinguisme
  FR/EN est intégralement terminé** sur son périmètre initial
  ("Interface + documents") — voir journal 2026-08-17. Une re-vérification
  complète menée le même jour (script de balayage systématique plutôt que
  relecture manuelle) a trouvé et corrigé **9 trous supplémentaires** que
  les sessions précédentes avaient manqués : le composant `PrinterPanel`
  entier (jamais ouvert pendant les vérifications précédentes),
  `DEFAULT_LOCATIONS` (même piège que `DEFAULT_ROLES`, fonction
  `getLocationDisplayName` — 6 endroits dans `StockPage.tsx` + 1 dans
  `JournalsPage.tsx`), la vraie source du "Code PIN incorrect"
  (`useAuth.ts`, pas `packages/core` comme supposé au 2026-08-16),
  `packages/sync` (jamais rattaché à `@gestion-boutique/i18n` avant), et
  les libellés de compte/transaction du journal SYSCOHADA
  (`SyscohadaService.ts`, `syscohadaRoleLabels.*`/`syscohadaLabels.*`) —
  voir journal 2026-08-17 (entrée "re-vérification complète") pour le
  détail des 9 trous, la méthodologie, et les 4 restes volontairement non
  convertus (catégorisés, pas oubliés).

## Environnement de dev (spécifique à cette machine)

- Le projet a été renommé depuis `C:\Users\djaka\APPLI GESTION BOUT` vers
  `WariBox` le 2026-08-12 — si des chemins absolus vers l'ancien nom
  réapparaissent (`node_modules` cassés, `.claude/launch.json`, scripts
  `.cmd`), c'est ce renommage qui n'a pas été propagé. Solution : `pnpm
  install` pour régénérer les liens, et corriger les chemins en dur.
- `pnpm` n'est pas sur le PATH système global de cette machine. Installé
  localement via `npm install -g pnpm@9.15.0 --prefix
  "$HOME/.npm-global"` ; [dev-web.cmd](dev-web.cmd) et
  [preview-web.cmd](preview-web.cmd) incluent maintenant `C:\Users\djaka\.npm-global`
  dans leur PATH pour le trouver.
- `pnpm run build` (= `turbo run build` → `tsc -b && vite build` pour
  `apps/web`) est la vérification de référence — passe proprement à ce jour.
- `pnpm lint` **ne fonctionne pas** : le script existe mais `eslint` n'est
  installé nulle part et il n'y a aucun fichier de config. À corriger ou à
  retirer du `package.json` pour ne pas induire en erreur.
- `pnpm run test` (racine, via turbo) exécute maintenant les tests de
  `packages/core` (vitest) — voir journal ci-dessous.
- **Même piège de renommage côté cache Rust** (voir point ci-dessus, mais ça
  avait échappé au nettoyage initial) : `apps/desktop/src-tauri/target/release`
  et les 4 dossiers `target/<arch>-linux-android/release` peuvent contenir des
  chemins absolus figés vers l'ancien `APPLI GESTION BOUT` dans leurs
  `build/*/output`/`.d`/`root-output` — le symptôme est un échec de
  `tauri build`/`tauri android build` avec une erreur "chemin d'accès
  introuvable" qui mentionne l'ancien chemin, alors que cargo pense le build
  script à jour (son fingerprint ne dépend pas du chemin absolu du projet).
  **Solution** : `rm -rf` le(s) dossier(s) `release` concerné(s) sous
  `target/` (pas besoin de toucher `debug/`) puis relancer le build — force
  une recompilation complète mais fiable. Vu le 2026-08-14 sur `target/release`
  ET sur les 4 cibles Android en même temps.
- **Build Android natif sur Windows, pas WSL** : contrairement à ce que
  supposait (à tort) le commentaire de
  [collect-releases.mjs](scripts/collect-releases.mjs), cette machine a
  Android Studio + SDK + NDK 27.2.12479018 installés nativement sur Windows
  (`ANDROID_HOME`/`ANDROID_NDK_HOME`/`JAVA_HOME` déjà positionnés dans
  l'environnement) — `pnpm --filter @gestion-boutique/desktop tauri android
  build` fonctionne directement, aucun besoin de WSL.
- **Signature Android** : `gen/android/app/build.gradle.kts` (fichier
  généré une fois par `tauri android init` puis éditable — contrairement à
  `tauri.build.gradle.kts`/`tauri.properties` qui restent auto-générés à
  chaque build, voir leur en-tête) lit maintenant un `signingConfig` release
  depuis `gen/android/keystore.properties` s'il existe (sinon build non signé,
  comportement par défaut d'Android Gradle Plugin — un APK non signé ne
  s'installe sur aucun appareil réel). `gen/` entier est gitignored, donc le
  keystore et ses mots de passe ne partent jamais sur le dépôt — mais ça veut
  aussi dire qu'ils **ne survivent pas à un `git clone` propre ni à une
  suppression de `gen/`**, à sauvegarder à part si on veut réutiliser la même
  identité de signature d'une machine/session à l'autre. Un keystore de test
  (`gen/android/waribox-test-release.keystore`, alias `waribox`, mot de passe
  dans `gen/android/keystore-password.txt`) a été généré le 2026-08-14 —
  **usage test/sideload uniquement**, à remplacer par un vrai keystore de
  prod avant toute distribution réelle (Play Store ou autre). Un APK signé
  avec ce keystore de test est incompatible en mise à jour avec l'ancien APK
  du 2026-08-06 (signé avec un keystore différent, disparu depuis) : impossible
  d'installer par-dessus sans désinstaller l'ancien d'abord.

## Limitations connues (assumées, pas des bugs à corriger en urgence)

- **Pas d'ESLint fonctionnel** (voir section environnement).
- **Couverture de tests partielle** : seules les fonctions de calcul pures des
  services Ventes/Fidélité/Remboursements sont testées à ce jour (voir
  journal). Rien sur Stock, Promotions, SYSCOHADA, Comptabilité, Achats.

## Journal des décisions et travaux récents

### 2026-08-12 — Diagnostic environnement + sécurisation transactions + tests

**Contexte** : reprise du projet après un renommage de dossier qui avait cassé
l'environnement local (voir section Environnement ci-dessus). Après
réinstallation, le build passait déjà sans erreur TypeScript — bon signal sur
la qualité générale du code.

**Risque identifié en relisant `SalesService.createSale` /
`RefundsService.createRefund`** : `drizzle-orm/sqlite-proxy` n'a pas de
transactions natives, et aucun service n'en utilisait — les opérations
multi-étapes (vente : ligne de vente → mouvement de stock → paiement → crédit
→ points fidélité) n'étaient pas atomiques. Risque réel bien que l'app soit
single-user local : une exception en cours de séquence pouvait laisser un état
partiel (stock décrémenté sans paiement enregistré, etc.), et deux appels
concurrents pouvaient valider la même unité de stock avant qu'aucun n'écrive.

**Fait** :
- Ajouté `withTransaction()` dans
  [client.ts](packages/database/src/client.ts) — `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`
  bruts envoyés au worker + verrou de sérialisation (connexion SQLite unique,
  donc pas de vraie concurrence à gérer, juste éviter les transactions
  imbriquées).
- Enveloppé toute la séquence lecture-validation-écriture de `createSale` et
  `createRefund` dedans (pas seulement les écritures — voir la convention
  ci-dessus).
- Installé `vitest` dans `packages/core` (rien n'existait avant) + 17 tests
  unitaires sur les fonctions de calcul pures : `computeTaxAmount`,
  `computeSaleItemTotal` (renommé depuis `computeItemTotal`, qui entrait en
  conflit avec l'export du même nom dans `ServiceOrdersService.ts` — les deux
  fonctions sont des duplications volontaires, voir leurs commentaires),
  `pointsToDiscount`, `computeTier`, `allocateAcrossMagnitudes` (y compris un
  test qui reproduit le scénario réel de remboursements partiels répétés).
- Vérifié en conditions réelles dans le navigateur (pas juste le typecheck) :
  création de compte → produit → entrée de stock → vente au comptoir → stock
  décrémenté correctement → remboursement avec remise en stock → stock revenu
  à sa valeur d'origine. Aucune erreur console/serveur à aucune étape.
- Corrigé au passage : chemins absolus obsolètes dans `.claude/launch.json`,
  `dev-web.cmd`, `preview-web.cmd` (voir section Environnement).

**Pas fait / laissé de côté délibérément** (hors périmètre de cette session,
à reprendre si besoin) :
- Pas de transaction ajoutée sur `PurchasesService` (achats) — même risque
  théorique, non traité faute de demande explicite.
- Pas de tests d'intégration sur le rollback réel (nécessiterait un harnais
  SQLite en mémoire compatible avec le type `Database` du proxy — pas fait
  pour rester dans le périmètre demandé).
- ESLint toujours non installé.

### 2026-08-12 — Bug : le sélecteur de boutique ne suivait pas la désactivation du multi-boutique

**Symptôme rapporté** : après avoir désactivé "Activer plusieurs boutiques"
dans Paramètres, le sélecteur de boutique dans la barre du haut restait
affiché un moment avant de disparaître.

**Cause racine** : [StoreSwitcher.tsx](apps/web/src/features/stores/StoreSwitcher.tsx)
chargeait `multiStoreEnabled` et la liste des boutiques **une seule fois, à
son montage** (`useEffect` sans dépendance réactive). Comme il vit dans
`TopBar`, monté une seule fois par session (jamais démonté au changement
d'onglet), il ne se remettait à jour qu'au prochain démontage de tout l'arbre
authentifié — concrètement, un verrouillage/déverrouillage de session (manuel
ou automatique via `useIdleLock`), pas un simple délai. Les 5 autres endroits
qui lisent `multiStoreEnabled` (Dashboard, Rapports, Journaux, Utilisateurs,
`Nav` via `enabledModules`) n'ont pas ce problème : ils rechargent les
paramètres à chaque montage, qui a lieu à chaque visite de leur onglet.

**Fait** : aligné `StoreSwitcher` sur le pattern déjà en place pour `Nav` —
`multiStoreEnabled` et la liste des boutiques sont maintenant chargés dans
l'effet déjà existant de `MainContent` ([App.tsx](apps/web/src/app/App.tsx))
qui tourne à chaque changement d'onglet, et passés en props à `TopBar` puis
`StoreSwitcher` (qui ne fait plus sa propre lecture). Vérifié dans le
navigateur : activation → sélecteur apparaît après changement d'onglet ;
désactivation + sauvegarde → sélecteur disparaît dès le changement d'onglet
suivant, sans verrouillage/déverrouillage.

**Limite connue du correctif** : si l'utilisateur reste sur l'onglet
Paramètres après avoir sauvegardé, le sélecteur ne se met pas à jour tant
qu'il ne change pas d'onglet (l'effet ne tourne que sur `[db, tab]`). Pas
gênant en pratique (le sélecteur n'est de toute façon pas visible depuis
Paramètres dans le flux normal), mais à garder en tête si ce composant est
retouché.

### 2026-08-13 — Transactions achats, coût par lot pour la marge, runner de migrations, réappro, reçu WhatsApp

**Contexte** : suite des 3 correctifs suggérés en fin de session précédente,
plus deux nouvelles fonctionnalités (suggestion de réappro, envoi du reçu par
WhatsApp). Un opérateur mobile money spécifique par transaction (4e piste
proposée) a été explicitement écarté par le porteur du projet — pas fait.

**Correctif 1 — Transaction sur les achats** : `PurchasesService.createPurchase`
enveloppé dans `withTransaction()`, même modèle que `createSale`/`createRefund`.

**Correctif 2 — Runner de migrations suivies** : nouvelle table `__migrations`
+ tableau `MIGRATIONS` dans [client.ts](packages/database/src/client.ts),
chaque migration numérotée exécutée une seule fois, dans sa propre
transaction, sans avaler les erreurs — voir la section *Base de données /
migrations* ci-dessus pour la coexistence avec `MIGRATION_SQL` (legacy, gelé,
inchangé pour ne rien casser sur les bases existantes).

**Correctif 3 — Coût d'achat historisé par lot** :
- `stock_batches.unitCost` (migration `id: 1`), renseigné par
  `PurchasesService.createPurchase`, qui crée maintenant un lot par ligne
  achetée (avant : le stock d'achat ne passait par aucun lot).
- `ReportsService.getCostOfGoodsSoldBySaleAndVariant` calcule le coût réel à
  partir des mouvements de vente et du lot d'où ils proviennent, avec repli
  sur `products.purchasePrice` si lot inconnu — utilisé par
  `getMarginsSummary` et `getProductMarginsBreakdown` (remplace l'ancien
  calcul uniforme sur le prix d'achat courant). `allocateCostByQuantityShare`
  (testée) répartit le coût au prorata si une même variante apparaît sur
  plusieurs lignes d'une même vente.
- **Bug trouvé et corrigé pendant la vérification navigateur** :
  `StockService.transferStock` (Réserve ↔ Surface de vente) ne conservait pas
  l'association au lot — un transfert perdait le lot d'origine, donc le
  correctif ci-dessus ne s'appliquait jamais dans le flux normal
  Achat → Réserve → Transfert → Surface de vente → Vente (la quasi-totalité
  des ventes réelles). Corrigé en faisant suivre le même ordre FEFO que
  `consumeStockFefo` côté source, avec création d'un lot "miroir" (même
  coût/péremption) à l'emplacement de destination. Vérifié bout en bout dans
  le navigateur : achat à 650/unité (prix catalogue 500) → transfert → vente
  de 2 unités → rapport Marges affiche bien coût 1300 (2×650) et marge 700
  (35%), pas 1000/50% (2×500) comme avant le correctif.

**Fonctionnalité — Suggestions de réappro** : dans
[PurchasesPage.tsx](apps/web/src/features/purchases/PurchasesPage.tsx),
panneau listant les produits en stock bas (`getLowStockProducts`) avec une
quantité suggérée (ramène au double du seuil d'alerte), un clic pré-remplit
le panier d'achat existant — aucune nouvelle persistance, réutilise
entièrement le flux `createPurchase` déjà en place.

**Fonctionnalité — Reçu de vente par WhatsApp** :
`buildReceiptWhatsAppMessage` dans [whatsapp.ts](apps/web/src/lib/whatsapp.ts)
formate un message texte (l'app étant 100% locale sans serveur, pas de page
de reçu à héberger — un message pré-rempli est la seule forme de "reçu
numérique" possible ici). Bouton dans le bloc post-vente de
[SalesPage.tsx](apps/web/src/features/sales/SalesPage.tsx), téléphone
pré-rempli si un client enregistré avec un numéro est sélectionné, sinon
saisie libre (couvre le client de passage, très fréquent en POS). Lien
`wa.me` généré et contenu vérifiés dans le navigateur (URL et message
interceptés via `window.open`).

**Vérifié dans le navigateur**, pas juste le typecheck : le scénario complet
achat/transfert/vente/marge ci-dessus, la suggestion de réappro (calcul de
quantité + pré-remplissage du panier), et le lien WhatsApp généré. Aucune
nouvelle erreur console à aucune étape (des erreurs résiduelles d'une
expérimentation de debug ratée en cours de session — un second worker
`db-worker.js` créé manuellement, qui est entré en conflit de verrou avec
celui de l'app et a corrompu l'état OPFS de cet onglet — ont nécessité de
recréer le compte de test une fois ; sans lien avec le code livré).

**Pas fait / laissé de côté délibérément** :
- Opérateur mobile money spécifique (Orange Money/MTN/Wave/Moov) par
  transaction — écarté explicitement, non nécessaire selon le porteur du
  projet.
- ESLint toujours non installé.
- Pas de test d'intégration automatisé sur `transferStock`/le flux
  achat→marge (vérifié manuellement dans le navigateur, voir ci-dessus) —
  nécessiterait le même harnais SQLite en mémoire déjà noté comme hors
  périmètre à la session précédente.

### 2026-08-13 — Alertes péremption WhatsApp, indicateur sauvegarde, étiquettes après achat, rapport de clôture de caisse

**Contexte** : suite de la session précédente — 4 fonctionnalités proposées et
validées par le porteur du projet, avec une exigence précise sur la 4e
(visible Gérant/Propriétaire/Admin, traces d'ouverture/fermeture de caisse
dans le journal).

**Alerte WhatsApp péremptions proches** ([StockPage.tsx](apps/web/src/features/stock/StockPage.tsx)) :
même pattern que l'alerte stock bas déjà en place (`handleNotifyLowStock`),
réutilise le même numéro configuré (`business_settings.lowStockAlertPhone`) —
pas de champ dédié supplémentaire. Vérifié : lien `wa.me` et message
interceptés, contenu correct.

**Indicateur "sauvegarde en retard"** ([DashboardPage.tsx](apps/web/src/features/dashboard/DashboardPage.tsx)) :
nouvelle carte KPI utilisant `isBackupDue`/`listBackups` (déjà présents dans
`BackupService.ts`, non exploités jusqu'ici pour ça) + `settings.backupFrequency`.
Visible seulement pour `manage_settings` (Admin/Propriétaire) — aligné sur qui
peut effectivement agir depuis Paramètres → Sauvegardes. Vérifié : affiche
correctement "Jamais / En retard" sur une base sans sauvegarde.

**Étiquettes après un achat** ([PurchasesPage.tsx](apps/web/src/features/purchases/PurchasesPage.tsx)) :
le panier est capturé avant d'être vidé (`lastPurchaseLines`), un bouton dans
le bloc post-achat régénère un PDF d'étiquettes (`buildLabelSheetPdf` +
`ensureVariantBarcode`, même pattern que ProductsPage) avec une copie par
unité reçue. Vérifié : PDF de 89 Ko généré sans erreur.

**Rapport de clôture de caisse** (Rapports → onglet "Caisse", nouveau) :
- `CashSessionService.listCashSessions` (nouveau) — historique des sessions,
  ouvertes ou fermées, filtrable par période/boutique.
- `buildCashSessionsReportPdf`/`Excel` dans `packages/reports`, même
  convention que les autres rapports (`buildReportPdf`/`buildWorkbookBlob`).
- Onglet gated au niveau de la page (comme Ventes/Trésorerie) — `view_reports`
  suffit déjà à obtenir exactement Gérant/Propriétaire/Admin (Vendeur/Caissier
  ne l'ont pas), donc aucun nouveau système de permission n'a été nécessaire
  pour satisfaire l'exigence "visible par Gérant, Propriétaire, Admin".
- **Traces d'ouverture/fermeture dans Journaux → Actions** : déjà
  implémentées avant cette session (`CashSessionService.openSession`/`closeSession`
  appellent déjà `logAction` avec `openingAmount`/`closingAmount`+`expectedAmount`+`difference`,
  et `open_cash_session`/`close_cash_session` sont déjà dans `ACTION_LABELS`
  de JournalsPage.tsx) — rien à coder, seulement vérifié dans le navigateur
  que le format correspond à la demande ("tel jour, telle personne a ouvert
  la caisse avec tel montant à telle heure et l'a fermé avec tel montant à
  telle heure") : confirmé, ligne par ligne, avec écart calculé correctement
  sur un test réel (ouverture 0 → vente 2000 en espèces → fermeture comptée à
  1900 → écart -100 affiché aussi bien dans le rapport que dans le journal).

**Pas fait / laissé de côté** :
- Pas de mise en forme du timestamp de fermeture de session (`closedAt` est
  stocké en ISO avec millisecondes par `closeSession`, `openedAt` en format
  SQL `CURRENT_TIMESTAMP` — les deux s'affichent tels quels dans le rapport
  Caisse, incohérents visuellement mais corrects). Pré-existant, hors
  périmètre de cette session.
- Repéré en passant : `update_product` n'a pas d'entrée dans `ACTION_LABELS`
  (JournalsPage.tsx) et s'affiche donc en anglais brut dans Journaux → Actions,
  contrairement à `create_product`. Pré-existant, pas corrigé (hors périmètre).

### 2026-08-13 — Audit de sécurité : permissions manquantes côté service (défense en profondeur)

**Contexte** : audit de sécurité demandé explicitement, portée large (auth,
autorisation, injection, secrets, config Tauri...). Constat principal :
`requirePermission` (défense en profondeur, garde contre un appel direct qui
contournerait la restriction purement visuelle de l'UI — voir son commentaire
dans [permissions.ts](packages/core/src/domain/permissions.ts)) n'était câblé
que sur une poignée de services (Remboursements, Promotions, Boutiques,
Paramètres, Sauvegardes, Maintenance) depuis l'origine du projet. **Tout le
reste — ventes, achats, stock, produits, clients, fournisseurs, dépenses,
devis, tickets de service, créances, dettes, sessions de caisse — n'avait
aucune vérification de permission côté service**, uniquement des boutons
cachés côté UI. Un commentaire du code lui-même
([ServiceOrdersService.ts:257-259](packages/core/src/services/ServiceOrdersService.ts:257))
documentait d'ailleurs le schéma de permissions *prévu* sans jamais l'avoir
câblé — signe que ce n'était pas un choix délibéré mais un oubli systémique.

**Fait** : `requirePermission`/`requireAnyPermission` ajoutés à toutes les
fonctions de service qui écrivent des données, avec la permission qui
correspond exactement à ce que l'UI vérifie déjà (pour ne rien changer au
comportement observable) :

| Service | Fonctions | Permission |
|---|---|---|
| SalesService | createSale | manage_sales |
| PurchasesService | createPurchase | manage_suppliers (comme Nav) |
| StockService | transferStock | manage_stock |
| CashSessionService | openSession, closeSession | manage_sales |
| ProductsService | createCategory/createProduct/createVariant/updateProduct/updateVariantBarcode | manage_products |
| CustomersService | createCustomer | manage_customers |
| CustomersService | updateCustomer | edit_customers |
| SuppliersService | createSupplier | manage_suppliers |
| SuppliersService | updateSupplier | edit_suppliers |
| ExpensesService | createExpense | manage_expenses |
| ExpensesService | updateExpense, deleteExpense | edit_expenses |
| QuotesService | createQuote, convertQuoteToSale | manage_quotes |
| QuotesService | updateQuoteStatus | edit_quotes |
| ServiceOrdersService | createServiceOrder, updateServiceOrderItemStatus | manage_service_orders |
| ServiceOrdersService | updateServiceOrder, updateServiceOrderItem | edit_service_orders |
| DebtsService | recordDebtPayment | manage_debts |
| CreditsService | recordCreditRepayment | manage_credits **ou** manage_service_orders |

**Deux subtilités traitées explicitement** (pour ne pas casser des usages
internes légitimes en gardant une fonction partagée) :
- **Primitives partagées non gardées** : `StockService.recordMovement`/
  `createBatch` et `CustomersService.insertCustomer` (nouvelle primitive
  interne, extraite de `createCustomer`) restent volontairement sans
  vérification — elles sont réutilisées par plusieurs flux de haut niveau
  qui ont chacun leur propre permission déjà vérifiée (une vente crée un
  client via `findOrCreateCustomerByName` sans que le caissier n'ait besoin
  de `manage_customers`). Deux nouvelles fonctions dédiées,
  `addManualStockEntry`/`recordStockLoss`, gardent spécifiquement les deux
  actions manuelles de StockPage (qui appelaient ces primitives directement,
  sans aucune garde).
- **`requireAnyPermission`** (nouveau, dans permissions.ts) : pour
  `recordCreditRepayment`, invoquée à la fois depuis Créances
  (`manage_credits`) et depuis le suivi des tickets de service
  (`manage_service_orders`, pour régler une créance née d'un ticket
  partiellement payé) — une seule des deux permissions suffit.

**Correctif additionnel** : `verifyMaintenanceCode` n'avait aucun
anti-brute-force, contrairement au mot de passe/PIN (`MAX_FAILED_ATTEMPTS`/
`LOCKOUT_MS` déjà dans AuthService). Ajouté le même mécanisme, avec deux
nouvelles colonnes sur `business_settings` (migration `id: 2`, voir le
runner de migrations mis en place à la session précédente).

**Vérifié dans le navigateur**, pas juste le typecheck : créé un compte
Admin + un compte Caissier, impersonation vers Caissier, ouverture de caisse
et vente complète (VTE-2026-000001) réussies sans erreur — confirme que les
nouvelles vérifications de permission ne cassent pas le travail quotidien
d'un rôle restreint. Nav confirmée cohérente (Caissier ne voit que
Accueil/Ventes/Devis). `pnpm run build` (rebuild forcé) et les 20 tests
unitaires passent.

**Autres constats de l'audit (pas de correctif nécessaire)** :
- Hachage des mots de passe/PIN/code de maintenance : Argon2id, paramètres
  conformes à la recommandation OWASP, sel aléatoire — voir
  [hash.ts](packages/core/src/auth/hash.ts). Aucun changement nécessaire.
- Aucune injection SQL trouvée — Drizzle ORM utilisé partout, aucune
  concaténation de chaîne SQL avec une entrée utilisateur.
- Aucun XSS trouvé — pas de `dangerouslySetInnerHTML`/`innerHTML`/`eval`
  dans `apps/web/src`. Le logo (upload libre, y compris SVG) est rendu via
  `<img src>`, pas `<object>`/inline DOM — un SVG malveillant n'y exécute
  jamais de script.
- Session non persistée (`stores/session.ts` est un store Zustand en
  mémoire, rien en `localStorage`/`sessionStorage`) — un rechargement de
  page exige une reconnexion, pas de jeton à voler.
- CSP Tauri déjà correcte ([tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json)) :
  pas de `script-src 'unsafe-inline'`, scope `connect-src`/`frame-src`
  limité à `self` + Google (nécessaire pour la sauvegarde Drive).
- OAuth Google Drive : scope `drive.file` (l'app ne voit que les fichiers
  qu'elle a elle-même créés, jamais tout le Drive), jeton en mémoire
  uniquement.
- `impersonateUser` (Admin/Propriétaire peuvent se connecter comme n'importe
  qui sans mot de passe) est une fonctionnalité voulue et documentée
  (dépannage), pas une faille — les deux rôles qui y ont accès ont de toute
  façon déjà toutes les permissions.

**Pas fait / laissé de côté** :
- Permissions en lecture seule (ex. `view_accounting`, `view_reports` sur
  les fonctions `get*`) non ajoutées côté service — seules les écritures ont
  été gardées, cohérent avec le périmètre déjà établi par le code existant
  (RefundsService etc. ne gardent que les mutations).
- Pas de test automatisé sur le rejet effectif d'un appel sans permission
  (vérifié par lecture de code + le même mécanisme déjà utilisé avec succès
  ailleurs dans le projet), faute d'un harnais d'intégration — même limite
  que le reste du projet (voir pistes ci-dessous).

### 2026-08-13 — Analyse concurrentielle + veille réglementaire FNE (Côte d'Ivoire)

**Contexte** : demande explicite d'analyser le marché concurrentiel et la
logique interne de l'app pour proposer des améliorations. Recherche web
réelle effectuée (pas de mémoire figée) sur 3 familles de concurrents :
généralistes cloud (Loyverse/Square/Odoo POS), POS "Afrique offline"
génériques (digabloPos, InkeepX, CliqPOS, TselevPOS), ERP/compta SYSCOHADA
francophones (KiboERP, Nimba ERP, Madata, CassKai, DIAM POS, OdaSoft).

**Constat le plus important — obligation légale, pas juste une feature** :
la **Facture Normalisée Électronique (FNE)** est obligatoire en Côte d'Ivoire
depuis le **1er décembre 2025**, pour toute entreprise sans exception de
régime fiscal (pas seulement les assujetties à la TVA) — décret n°0337 du
9 mai 2025, DGI. Sanctions : amendes jusqu'à 10M FCFA, attestation de
régularité fiscale bloquée (donc accès aux marchés publics bloqué) sans
inscription. WariBox a un export SYSCOHADA comptable périodique mais
**aucune émission de facture certifiée FNE à la vente** — plusieurs
concurrents directs (Madata, CassKai) en ont déjà fait un argument
commercial. Non traité cette session : le porteur du projet n'a pas encore
de compte DGI/clé API FNE, donc pas de vraie spec à coder contre (voir
ci-dessous). **À reprendre dès qu'un compte DGI est disponible.**

**Recherche technique sur l'API FNE** (pour préparer une future intégration) :
pas de doc officielle exploitable à distance (PDF DGI illisible via fetch),
mais le SDK PHP tiers non-officiel [PRODESTIC/fne-sdk-php](https://github.com/PRODESTIC/fne-sdk-php)
donne la forme réelle de l'API :
- Auth par clé API, obtenue dans l'espace entreprise **après validation par
  la DGI** (pas un simple sign-up développeur) — environnements test/prod
  distincts, URL de prod communiquée par la DGI à la validation.
- Opérations : certification facture de vente, certification document
  d'achat, note d'avoir (référence la facture d'origine).
- Facture : template **B2C/B2B/B2F/B2G** (B2B exige le NCC du client),
  lignes avec taux de taxe (`TAX_TVA` 18%, `TAX_TVAB` 9%, `TAX_TVAC`/`TAX_TVAD` 0%).
- Réponse : numéro de facture normé + NCC + token QR code + **quota de
  "stickers" restants** (pas illimité, à surveiller).
- **Aucun mécanisme de file d'attente offline documenté** côté DGI (juste un
  "retry automatique en cas d'erreur réseau") — à construire entièrement côté
  WariBox si implémenté un jour : facture émise localement tout de suite
  (comme aujourd'hui), statut "en attente de certification FNE", tentative en
  tâche de fond au retour réseau.

**Autres écarts identifiés vs le marché** (moins urgents, proposés mais pas
retenus pour implémentation cette session — le porteur du projet a choisi de
ne rien faire coder cette session, juste garder l'analyse) :
- Réappro prédictif basé sur la vitesse de vente réelle (30 derniers jours)
  plutôt que le seuil fixe actuel (`getLowStockProducts` — voir la feature
  "Suggestions de réappro" de la session du 2026-08-13 précédente).
- Sync multi-appareils temps réel (CRDT/local-first) — écart architectural
  majeur, pas une simple feature : WariBox reste "un appareil = une base"
  même en multi-boutique (le multi-boutique existe en données, pas en
  synchronisation temps réel entre postes). Noté pour référence future
  uniquement, aucune action engagée.

**Pas fait / laissé de côté délibérément** :
- Intégration FNE : bloquée faute de compte DGI réel pour tester contre la
  vraie API — coder contre les specs déduites d'un SDK tiers non-officiel
  serait risqué (probable réécriture au premier vrai test). Reprendre dès
  qu'un accès DGI existe, idéalement avec le PDF officiel
  `FNE-procedureapi.pdf` fourni en texte lisible plutôt qu'en PDF binaire.
- Réappro prédictif et correctif `ACTION_LABELS` (`update_product`) :
  proposés, non retenus pour cette session (porteur du projet : "rien pour
  l'instant") — restent en piste ci-dessous.
- Sync multi-appareils : hors périmètre, gros chantier d'architecture.

### 2026-08-14 — Build Windows/Android/PWA + bug "mise à jour depuis Paramètres" ne fonctionne pas

**Contexte** : demande de builder les trois cibles (Windows, Android, PWA),
puis signalement d'un bug sur l'installation de mise à jour depuis
Paramètres.

**Build des trois cibles** — PWA (`pnpm build`), Windows (`pnpm
build:desktop`) et Android (`pnpm --filter @gestion-boutique/desktop tauri
android build`) tous fonctionnels, livrables rassemblés par `pnpm
collect:releases` dans `releases/`. Deux obstacles rencontrés et corrigés,
tous deux documentés dans la section *Environnement de dev* ci-dessus :
chemins absolus obsolètes dans le cache Rust (`target/release` + les 4
cibles Android), et absence de keystore de signature Android (un keystore de
test a été généré, voir section Environnement).

**Bug rapporté — "la mise à jour depuis les paramètres ne fonctionne pas"** :
important de comprendre d'abord ce que cette fonctionnalité *n'est pas* : il
n'existe **aucune mise à jour automatique** dans WariBox (pas de
`tauri-plugin-updater`, pas de manifeste de releases, pas de vérification
"nouvelle version disponible"). Ce que Paramètres propose
([SettingsPage.tsx:1053](apps/web/src/features/settings/SettingsPage.tsx:1053))
est un flux **manuel** : l'utilisateur choisit lui-même un `.exe`/`.msi` déjà
présent sur le disque, saisit le code de maintenance, puis l'app lance ce
fichier via `openPath` (`@tauri-apps/plugin-opener`) avant de se fermer.
C'est comme ça depuis le tout premier commit, pas une régression.

**Deux bugs distincts trouvés et corrigés** :
1. **Message d'erreur inutile** : le pattern `err instanceof Error ?
   err.message : "texte générique"`, répété à plusieurs endroits de
   `SettingsPage.tsx`, avale le vrai message quand une commande Tauri rejette
   avec une simple chaîne côté Rust (fréquent avec l'IPC Tauri) plutôt qu'un
   objet `Error` JS — exactement ce qui se produisait ici. Ajouté un helper
   `describeError()` (juste après `downloadBlob` dans SettingsPage.tsx) qui
   récupère le message réel dans ces cas aussi ; appliqué aux deux points de
   la chaîne mise à jour (`handlePickUpdateFile`, `handleInstallUpdate`).
   **Seuls ces deux points ont été corrigés** — le même pattern existe à 8
   autres endroits du fichier (sauvegarde, import, logo...), non touchés
   (hors périmètre du bug signalé, voir piste ci-dessous).
2. **Cause racine réelle, révélée par le correctif ci-dessus** : `"Not
   allowed to open path"` — Tauri v2 distingue *permission* (le droit
   d'appeler `open_path`) et *scope* (quels chemins elle peut ouvrir).
   `opener:allow-open-path` était accordée dans
   [capabilities/default.json](apps/desktop/src-tauri/capabilities/default.json)
   **sans scope** — le schéma généré confirme explicitement que cette
   permission seule active la commande "without any pre-configured scope",
   donc scope vide = aucun chemin autorisé. Corrigé en ajoutant `"allow":
   [{"path": "**"}]` à cette permission — un scope large est justifié ici
   puisque la fonctionnalité laisse délibérément l'utilisateur choisir un
   fichier n'importe où sur le disque (clé USB, Téléchargements, dossier
   WhatsApp Desktop...).

**Correctif additionnel — bloc "Installer une mise à jour" visible sur
Android** : une fois Windows confirmé fonctionnel, question posée sur l'état
des autres cibles. Réponse : la PWA a son propre vrai mécanisme de mise à
jour (service worker + [UpdateBanner.tsx](apps/web/src/components/UpdateBanner.tsx),
monté inconditionnellement dans `App.tsx`, sans rapport avec Paramètres —
rien à corriger dessus). Mais sur Android, `isTauriRuntime()` (qui ne teste
que `isTauri()`, vrai pour desktop **et** mobile) laissait le bloc "Installer
une mise à jour" s'afficher alors qu'il est entièrement pensé pour Windows
(sélecteur filtré sur `.exe`/`.msi`, `openPath` qui ne sait pas installer un
`.apk` de cette façon) — pas cassé comme le bug Windows, juste incohérent/
inutile sur ce runtime. Ajouté `isDesktopTauriRuntime()` dans
[tauriRuntime.ts](apps/web/src/features/settings/tauriRuntime.ts) (détection
`navigator.userAgent` contenant `"Android"`, faute de
`@tauri-apps/plugin-os`), utilisé uniquement pour gater ce bloc dans
`SettingsPage.tsx` — `isTauriRuntime()` reste inchangée et utilisée telle
quelle ailleurs ([openExternalUrl.ts](apps/web/src/lib/openExternalUrl.ts)),
où desktop et Android doivent au contraire être traités pareil. Voir la
convention ajoutée plus haut (*Conventions métier importantes*) pour ne pas
retomber dans ce piège sur un futur bloc desktop-only.

**Pas fait / laissé de côté** :
- Les 8 autres occurrences du pattern `instanceof Error ? ... : "texte
  générique"` dans SettingsPage.tsx (sauvegarde locale/Drive, import,
  logo...) ont le même défaut potentiel (message réel avalé en cas de rejet
  non-`Error`) mais n'ont pas été touchées — aucun bug rapporté dessus,
  hors périmètre de cette session.
- Toujours pas de vraie mise à jour automatique (vérification de version,
  téléchargement) — le flux reste manuel par design actuel, non remis en
  cause cette session.

### 2026-08-15 — Nouvelle page "Historique des ventes" (Propriétaire/Gérant/Admin)

**Contexte** : demande explicite d'un menu dédié pour Propriétaire/Gérant/
Admin listant tout l'historique des ventes, avec un bouton "Rapport" par
vente générant un PDF détaillé, filtrable par date/vendeur/boutique/mode de
paiement/client. Proposition faite avant codage (format du PDF : ticket
existant vs A4 ; filtres à ajouter) — porteur du projet a choisi le format
ticket existant et les trois filtres supplémentaires.

**Fait** :
- [SalesService.ts](packages/core/src/services/SalesService.ts) :
  `SaleFilters` étendu avec `storeId`/`customerId`/`paymentMethod` (ce
  dernier résolu via une requête sur `payments` — le mode de paiement n'est
  pas sur `sales`). Deux nouvelles fonctions : `getSalePayment` (paiement
  d'une vente précise) et `listSalePayments` (tous les paiements de vente en
  une fois, pour afficher le mode de paiement dans une liste sans requête
  par ligne).
- [SalesHistoryPage.tsx](apps/web/src/features/sales/SalesHistoryPage.tsx)
  (nouveau) : liste filtrable (date, vendeur, boutique si multi-boutique,
  mode de paiement, client via `SearchableSelect`, recherche par numéro),
  reprend le pattern déjà établi par l'onglet Ventes de Journaux (`FilterBar`
  + tableau) mais gated sur `view_reports` au lieu de `view_audit_logs` —
  Journaux lui-même n'a pas été touché (reste Admin-only, c'est voulu).
  Bouton "Rapport" par ligne : reconstruit un `ReceiptData` complet depuis la
  vente stockée (`listSaleItems` + `getSalePayment`/map de paiements déjà
  chargée + listes users/customers/variants/products déjà en mémoire) et
  réutilise **`buildReceiptPdf`** (déjà existant dans `packages/printer`,
  jusqu'ici seulement appelé juste après une vente en cours) — aucun nouveau
  gabarit PDF créé, conformément au choix du porteur du projet.
- [Nav.tsx](apps/web/src/app/Nav.tsx) : nouvel onglet `sales_history`
  ("Historique des ventes"), permission `view_reports` (déjà exactement
  Propriétaire/Gérant/Admin, rien à changer côté permissions.ts),
  `moduleKey: "sales"` (suit l'activation/désactivation du module Ventes,
  comme Devis).

**Vérifié dans le navigateur**, pas juste le typecheck : compte Admin créé,
produit + stock + vente réels (VTE-2026-000001), page Historique des ventes
confirmée avec les bonnes colonnes (numéro/date/client/vendeur/mode de
paiement/total/statut), filtre "Vendeur" et filtre "Mode de paiement"
vérifiés (ce dernier avec un cas négatif : sélectionner "Mobile Money" sur
une vente en espèces vide bien la liste, "Réinitialiser" la fait
réapparaître), génération du PDF "Rapport" interceptée et confirmée (blob
PDF valide, nom de fichier correct). Aucune erreur console à aucune étape.
`pnpm run build` et les 20 tests unitaires passent.

**Pas fait / laissé de côté** :
- Pas de test manuel du filtre "Boutique" (nécessiterait d'activer le
  multi-boutique et de créer une deuxième boutique) ni du filtre "Client"
  (nécessiterait un client enregistré) — code identique en structure aux
  filtres déjà testés (`storeId`/`customerId` sur `sales`, même mécanique
  que `userId`), risque jugé faible, mais à garder en tête si un bug y est
  signalé.
- Pas de vérification UI qu'un rôle Vendeur/Caissier ne voit pas l'onglet
  (confiance placée dans `view_reports`, déjà utilisé et vérifié par
  ailleurs pour Rapports).

### 2026-08-15 — Bug texte coupé sur les PDF ticket + rapport Tickets de service dans Rapports

**Contexte** : retour utilisateur sur un vrai ticket de service produit en
PDF (capture d'écran) — deux problèmes distincts repérés dessus.

**Bug 1 — texte coupé sur les PDF ticket** :
[receiptPdf.ts](packages/printer/src/receiptPdf.ts) utilisait une taille de
police fixe (9pt Courier) quelle que soit la largeur du ticket (58mm/32 col
ou 80mm/48 col), sans jamais faire de retour à la ligne. Or 9pt Courier fait
environ 1.9mm/caractère — largement plus que ce que suppose `columns`
(1.56mm/car. pour tenir 32 caractères dans 50mm utiles) : toute ligne pleine
(séparateurs, articles) débordait déjà de 20 à 30% de la page, et les
phrases fixes (adresse, "Merci de votre visite !", "Conservez ce ticket...")
n'étaient jamais retournées à la ligne — d'où le texte visiblement tronqué
en fin de ticket. **Corrigé** :
- `renderLines` calcule maintenant la taille de police pour que `columns`
  caractères Courier tiennent exactement dans la largeur utile du PDF
  (`usableWidthMm / columns / COURIER_MM_PER_PT`, plafonné à 9pt) — vérifié
  mathématiquement avec la vraie librairie jsPDF (`doc.getTextWidth`) : la
  ligne séparatrice de `columns` caractères mesure maintenant pile la
  largeur utile, sur les deux préréglages.
- Nouveau helper `wrapText`/`pushWrapped` : toute ligne de texte libre
  (nom/adresse/téléphone/email du commerce, nom client, phrases de pied de
  ticket, libellé d'article trop long pour `padLine`) est maintenant
  retournée à la ligne sur `columns` caractères, comme le ferait une
  imprimante ESC/POS physique — plutôt que de continuer hors-page. Appliqué
  identiquement dans `buildReceiptPdf` (reçu de vente) et
  `buildServiceOrderTicketPdf` (bon de dépôt), les deux partageant `renderLines`.
- Vérifié avec un ticket de service réel (description d'article
  volontairement longue) : PDF généré sans erreur, aucun texte visuellement
  coupé.

**Fonctionnalité — Nouvel onglet "Tickets de service" dans Rapports** :
demande explicite car aucun moyen n'existait de régénérer un rapport PDF
pour un ticket de service **déjà passé** (seul le ticket tout juste créé
pouvait être exporté, exactement le même trou que pour les ventes avant la
session du 2026-08-15 précédente). Proposition faite avant codage (onglet
Rapports vs bouton dans l'Historique existant de Tickets de service vs page
dédiée) — porteur du projet a choisi l'onglet dans Rapports, cohérent avec
Ventes/Marges/Trésorerie/Caisse déjà là.
- [ServiceOrdersService.ts](packages/core/src/services/ServiceOrdersService.ts) :
  `listServiceOrders(db, storeId?)` → `listServiceOrders(db, filters:
  ServiceOrderFilters)` (`storeId`/`from`/`to`, même pattern que
  `SaleFilters`) — **signature changée**, les 3 autres points d'appel
  existants (`ServiceOrdersPage.tsx`, `DashboardPage.tsx`, `CreditsPage.tsx`)
  mis à jour en conséquence. Nouvelle fonction `getServiceOrderPayment`
  (même rôle que `SalesService.getSalePayment`).
- [ReportsPage.tsx](apps/web/src/features/reports/ReportsPage.tsx) : nouvel
  onglet "Tickets de service", visible seulement si le module Tickets de
  service est activé (`enableServiceOrders`, même convention que l'onglet
  "TVA" gated par `taxEnabled`) — gated par `view_reports` comme le reste de
  la page (Propriétaire/Gérant/Admin). Bouton "Rapport" par ligne :
  reconstruit un `ServiceOrderTicketData` depuis le ticket stocké
  (`listServiceOrderItems` + `getServiceOrderPayment` + `businessSettings`
  déjà chargés dans `refresh()`) et réutilise **`buildServiceOrderTicketPdf`**
  (déjà existant, jusqu'ici seulement appelé juste après la création d'un
  ticket) — même principe que le bouton "Rapport" de Historique des ventes.

**Vérifié dans le navigateur**, pas juste le typecheck : module Tickets de
service activé (repéré désactivé par défaut sur ce compte de test — piège à
retenir : le module n'est pas coché par défaut à l'installation), ticket
TCK-2026-000001 créé avec une description d'article volontairement longue,
onglet "Tickets de service" confirmé dans Rapports avec les bonnes colonnes,
génération du rapport PDF interceptée et confirmée (blob valide, nom de
fichier correct). Aucune erreur console. `pnpm run build` et les 20 tests
unitaires passent.

**Pas fait / laissé de côté** :
- Pas de filtre dédié (vendeur, statut paiement) sur l'onglet Tickets de
  service — réutilise seulement les filtres date/boutique déjà globaux à la
  page Rapports, non demandé explicitement pour cette fonctionnalité.
- Le mode de paiement n'apparaît pas sur le PDF du bon de dépôt — le
  template `ServiceOrderTicketData` n'a jamais eu ce champ (contrairement à
  `ReceiptData` des ventes), pas ajouté ici (hors périmètre du bug/demande
  signalés).

### 2026-08-15 — 4 petits correctifs + réappro prédictif

**Contexte** : suite de la proposition de la session précédente (5 pistes),
porteur du projet a validé les 4 premières pour implémentation immédiate ;
la 5e (FNE) reste notée en piste ci-dessous, bloquée faute de compte DGI.

1. **Pattern `instanceof Error` généralisé** : les 8 occurrences restantes de
   `err instanceof Error ? err.message : "texte générique"` dans
   `SettingsPage.tsx` (sauvegarde locale/Drive, téléchargement, logo, import,
   code de maintenance) remplacées par `describeError()` — même correctif
   que celui déjà appliqué au flux de mise à jour le 2026-08-14, généralisé
   au reste du fichier.
2. **`update_product` ajouté à `ACTION_LABELS`** (JournalsPage.tsx) →
   "Produit modifié". Vérifié dans le navigateur : modification d'un produit
   affiche maintenant le libellé français dans Journaux → Actions (avant :
   `update_product` brut).
3. **Format de date `closedAt` aligné sur `openedAt`** dans
   [CashSessionService.ts](packages/core/src/services/CashSessionService.ts) :
   `closeSession` utilisait `new Date().toISOString()` (format `...T...Z` +
   millisecondes) alors qu'`openedAt` vient du défaut SQL `CURRENT_TIMESTAMP`
   (`YYYY-MM-DD HH:MM:SS`, UTC, sans ms) — même repli que
   `AuthService`/`MaintenanceService` pour `lockedUntil`
   (`.toISOString().replace("T", " ").slice(0, 19)`). Vérifié dans le
   navigateur : les colonnes Ouverture/Fermeture du rapport Caisse affichent
   maintenant un format identique.
4. **Réappro prédictif** : nouvelle fonction
   [StockService.getSalesVelocity](packages/core/src/services/StockService.ts)
   (vitesse de vente réelle par variante sur `days` derniers jours, lue
   depuis le grand livre `stock_movements` où `movementType='sale'`).
   `PurchasesPage.tsx` : la quantité suggérée couvre maintenant les 30
   prochains jours au rythme de vente réel des 30 derniers jours
   (`dailyVelocity × 30 − stockActuel`), avec repli sur l'ancien calcul
   (ramener au double du seuil d'alerte) si le produit n'a aucune vente sur
   la période — nouvelle colonne "Basé sur" dans le tableau pour indiquer
   quel mode s'est appliqué. Vérifié dans le navigateur avec un scénario
   réel : 6 unités vendues sur la période, stock ramené à 4 (sous le seuil
   de 5) → suggestion de 2 (6 − 4), étiquetée "Ventes réelles (30j)".

**Vérifié dans le navigateur**, pas juste le typecheck, pour les 4 points
(voir détails ci-dessus). Aucune erreur console. `pnpm run build` et les 20
tests unitaires passent.

### 2026-08-15 — Bilinguisme FR/EN : infrastructure + premier lot de pages

**Contexte** : demande explicite de rendre l'app bilingue. Périmètre
(interface + documents) et approche (infra + pages principales d'abord,
reste en sessions suivantes) validés avant codage — voir la nouvelle section
*Internationalisation (i18n)* ci-dessus pour l'architecture, ce journal ne
couvre que ce qui a été fait concrètement cette session.

**Fait** :
- Nouveau package [`@gestion-boutique/i18n`](packages/i18n) : instance
  `i18next` partagée + dictionnaires `fr.json`/`en.json`.
- `apps/web` : `react-i18next` installé, `I18nextProvider` monté à la racine
  de `App.tsx`, store `useLanguageStore` (localStorage, même convention que
  le thème), sélecteur FR/EN ajouté dans `TopBar.tsx`.
- Cinq surfaces converties aux clés de traduction : `Nav.tsx` (les 19
  entrées de menu), `TopBar.tsx` (bannière d'impersonation, boutons),
  `DashboardPage.tsx` (Accueil, toutes les cartes KPI), `SalesPage.tsx`
  (mode Caisse/Formulaire, panier, promotions, fidélité, paiement,
  `OpenCashSessionScreen.tsx`/`CloseCashSessionPanel.tsx` inclus), et
  `SalesHistoryPage.tsx` (filtres, tableau, bouton Rapport).
- [FilterBar.tsx](apps/web/src/components/FilterBar.tsx) (composant partagé
  Journaux/Stock/Dépenses/Historique des ventes) converti au passage —
  repéré pendant la vérification de Historique des ventes (labels "Du/Au/
  Recherche/Réinitialiser" codés en dur dans le composant partagé, pas
  seulement dans la page). **Effet de bord accepté** : les pages qui
  utilisent `FilterBar` mais ne sont pas encore converties (Journaux, Stock,
  Dépenses) afficheront désormais ce composant en anglais si la langue est
  EN, alors que le reste de leur page reste en français — mélange
  temporaire inévitable tant que ces pages ne sont pas converties à leur
  tour, pas un bug.

**Vérifié dans le navigateur**, pas juste le typecheck : bascule FR→EN en
direct confirmée sans rechargement sur toutes les surfaces ci-dessus,
persistance confirmée après rechargement complet de la page (`localStorage`
relu au montage), scénario complet en anglais (ouverture de caisse → vente
→ historique des ventes → génération PDF "Report") vérifié sans erreur,
retour EN→FR confirmé. Aucune erreur console. `pnpm run build` et les 20
tests unitaires passent.

**Pas fait / laissé de côté délibérément** (périmètre restant, voir
Prochaines pistes) :
- Le reste des ~18 pages de `apps/web/src/features/` (Paramètres, Produits,
  Stock, Journaux, Dépenses, etc.) reste en français en dur — converties une
  à une dans les sessions suivantes, pas en un seul passage (risque
  d'erreurs trop élevé vu le volume, décision prise avant de commencer).
- L'écran de connexion (`AuthGate`/login) n'a pas été converti — visible
  volontairement en test : après un rechargement de page en anglais, l'écran
  de connexion s'affiche quand même en français (pas un bug, juste hors du
  périmètre de ce premier lot).
- Les messages d'erreur métier levés par `packages/core` (ex. "Stock
  insuffisant...") restent en français en dur — nécessiteront de remplacer
  chaque `throw new Error("...")` par une clé de traduction résolue via
  `t()` depuis `@gestion-boutique/i18n`, page par page en même temps que
  l'UI qui les affiche. Confirmé pendant la vérification : ce message
  s'affiche bien tel quel (en français) même avec l'UI en anglais, car
  c'est le vrai message d'erreur du service qui prime sur le texte de
  repli traduit du `catch`.
- Documents (tickets ESC/POS, PDF, rapports Excel) : aucun converti — même
  mécanique (`t()` importable directement dans `packages/printer`/
  `packages/reports`), à faire quand les pages correspondantes (Ventes,
  Rapports) seront converties. Le PDF "Rapport" généré depuis Historique des
  ventes reste donc en français quelle que soit la langue de l'interface.

### 2026-08-16 — Bilinguisme FR/EN : Paramètres converti

**Contexte** : suite du rollout i18n, plus gros morceau restant —
[SettingsPage.tsx](apps/web/src/features/settings/SettingsPage.tsx) (~1100
lignes, le plus gros fichier de pages de l'app).

**Fait** :
- Toutes les sections converties : Entreprise (nom/adresse/téléphone/email/
  indicatif WhatsApp/téléphone alerte stock/TVA/logo/format ticket), Modules
  actifs, Multi-boutique, Export SYSCOHADA (le texte de la carte, pas le
  contenu de `SyscohadaAccountsSection` — voir "Pas fait"), Points de
  fidélité (ratio + paliers Bronze/Argent/Or), Sécurité (verrouillage auto),
  Sauvegardes (locale/import/Google Drive + tableau d'historique), et
  Maintenance (code + flux "Installer une mise à jour" en entier, y compris
  tous les messages d'étape et d'erreur).
- Les listes `FREQUENCY_PRESETS`/`DESTINATION_LABELS`/`RECEIPT_PRESETS`
  (const module-level à l'origine) déplacées à l'intérieur du composant pour
  rester réactives au changement de langue — même correctif que
  `PAYMENT_METHOD_LABELS` sur `SalesHistoryPage.tsx` la session précédente,
  le même piège se reproduit à chaque fois qu'un tableau d'options utilise
  `t()`.
- **Perte cosmétique mineure acceptée** : le paragraphe d'avertissement
  SmartScreen mentionnait `.exe`/`.msi` en gras (`<strong>`) au milieu du
  texte français — la version traduite (`settings.maintenance.updateWarning`)
  est un seul bloc de texte sans ce gras, pour éviter la complexité d'un
  composant `Trans` dès ce premier passage. Le sens reste intact, seule la
  mise en emphase est perdue.

**Bug trouvé et corrigé pendant la vérification navigateur** : le bouton
"Choisir un dossier" (section Sauvegarde locale) avait été oublié lors de la
conversion — repéré parce qu'il restait affiché en français au milieu d'une
page entièrement en anglais lors du test. Corrigé et revérifié.

**Vérifié dans le navigateur**, pas juste le typecheck : page Paramètres
entière parcourue en anglais (toutes les sections listées ci-dessus),
bouton "Save" cliqué avec confirmation "Saved." affichée correctement,
retour en français confirmé. Aucune erreur console. `pnpm run build` et les
20 tests unitaires passent.

**Pas fait / laissé de côté délibérément** :
- [StoresSection.tsx](apps/web/src/features/stores/StoresSection.tsx) (135
  lignes, gestion des boutiques) et
  [SyscohadaAccountsSection.tsx](apps/web/src/features/settings/SyscohadaAccountsSection.tsx)
  (275 lignes, mapping des comptes SYSCOHADA) — tous deux rendus à
  l'intérieur de Paramètres quand leur module respectif est activé, mais pas
  convertis cette session (410 lignes à eux deux, sous-fonctionnalités plus
  spécialisées que le cœur de Paramètres). **Même effet de bord que
  `FilterBar`** : si multi-boutique ou SYSCOHADA est activé et que la langue
  est EN, ces deux blocs s'afficheront en français au milieu d'une page
  Paramètres autrement en anglais — pas un bug, juste pas encore converti.
  **Convertis dans la foulée, voir entrée suivante.**

### 2026-08-16 — Bilinguisme FR/EN : StoresSection + SyscohadaAccountsSection convertis

**Contexte** : suite immédiate de l'entrée précédente — les deux blocs
explicitement laissés de côté (rendus conditionnellement dans Paramètres
selon les modules Multi-boutique/SYSCOHADA activés).

**Fait** :
- [StoresSection.tsx](apps/web/src/features/stores/StoresSection.tsx)
  entièrement converti (`storesSection.*` : en-tête, description, tableau
  boutiques, formulaire d'ajout, erreurs).
- [SyscohadaAccountsSection.tsx](apps/web/src/features/settings/SyscohadaAccountsSection.tsx)
  entièrement converti (`syscohadaSection.*`, y compris le sous-namespace
  `roles.*` pour les 11 libellés de rôle de compte — Clients, Fournisseurs,
  TVA ventes/services/achats, Banques, Caisse, Mobile Money, Achats, Ventes,
  Services). `ROLE_FIELDS` (tableau `{key, label}` utilisant `t()`) déplacé à
  l'intérieur du composant — même piège récurrent que
  `FREQUENCY_PRESETS`/`PAYMENT_METHOD_LABELS` des sessions précédentes.

**Vérifié dans le navigateur**, pas juste le typecheck : multi-boutique et
export SYSCOHADA activés temporairement depuis Paramètres pour faire
apparaître les deux blocs, page entière parcourue en anglais (boutique
"Boutique principale" avec bouton "Disable", formulaire "Add a store", les
11 libellés de rôle de compte SYSCOHADA, "Save accounts", tableau des
mappings de charge par catégorie avec les catégories existantes — données
utilisateur, restent en français, comportement attendu), retour en français
confirmé. Les deux modules désactivés à nouveau après vérification pour
laisser l'état de test comme trouvé. Aucune erreur console (hors WebSocket
HMR habituel). `pnpm run build` et les 20 tests unitaires passent.

**Pas fait / laissé de côté** : aucun — ces deux blocs étaient le seul
reliquat non converti de la page Paramètres, celle-ci est maintenant
intégralement bilingue.

### 2026-08-16 — Bilinguisme FR/EN : Journaux, Stock, Dépenses convertis

**Contexte** : suite du rollout, ciblant en priorité Journaux/Stock/Dépenses
puisque les trois utilisent déjà le composant partagé `FilterBar` (traduit
le 2026-08-15) — les convertir élimine le mélange de langue transitoire que
`FilterBar` traduit créait sur ces pages tant qu'elles restaient en français.

**Fait** :
- [JournalsPage.tsx](apps/web/src/features/journals/JournalsPage.tsx)
  entièrement converti : les 3 onglets (Ventes/Stock/Actions), leurs
  filtres, colonnes de tableau, et les listes `PAYMENT_STATUS_LABELS`/
  `MOVEMENT_TYPE_LABELS`/`LOSS_REASON_LABELS`/`ACTION_LABELS` (déplacées à
  l'intérieur du composant — même piège récurrent que les sessions
  précédentes). `ACTION_LABELS` couvre les 29 types d'action du journal
  d'audit (`journals.actionLabels.*`).
- [RefundModal.tsx](apps/web/src/features/journals/RefundModal.tsx) et
  [RefundHistoryModal.tsx](apps/web/src/features/journals/RefundHistoryModal.tsx)
  convertis dans la foulée (`journals.refundModal.*`/
  `journals.refundHistoryModal.*`/`journals.refundMethods.*`) — ouverts
  depuis l'onglet Ventes de Journaux, auraient sinon laissé une modale
  entièrement en français au milieu d'une page traduite.
- [StockPage.tsx](apps/web/src/features/stock/StockPage.tsx) entièrement
  converti (`stock.*`) : alertes stock bas/péremptions proches (texte UI —
  les messages WhatsApp générés par `handleNotifyLowStock`/
  `handleNotifyExpiring` restent volontairement en français, même
  traitement que les autres documents/communications sortantes non encore
  converties, voir *Pas fait*), tableau de stock, formulaires Entrée/
  Transfert/Retrait. `LOSS_REASONS` réutilise les clés
  `journals.lossReasons.*` déjà créées pour Journaux plutôt que de dupliquer
  les 4 libellés.
- [ExpensesPage.tsx](apps/web/src/features/expenses/ExpensesPage.tsx)
  entièrement converti (`expenses.*`) : formulaire, filtres, tableau.
  `EXPENSE_CATEGORIES` (Loyer, Eau, Électricité...) **non traduites** — ce
  sont des valeurs de données réellement stockées en base (catégorie de la
  dépense), pas du texte d'interface, même raisonnement que les catégories
  de mapping SYSCOHADA de la session précédente.

**Vérifié dans le navigateur**, pas juste le typecheck : bascule FR→EN sur
les 3 onglets de Journaux (Ventes/Stock/Actions, y compris les 29 libellés
d'action et la liste déroulante des types de mouvement), ouverture de la
modale Rembourser depuis Journaux → Ventes confirmée traduite, page Stock
parcourue en anglais (formulaires Entrée/Transfert/Retrait, motifs de
retrait), page Dépenses parcourue en anglais (formulaire + tableau + liste
déroulante méthode de paiement), retour en français confirmé sur Dépenses.
Aucune erreur console (hors WebSocket HMR habituel). `pnpm run build` et les
20 tests unitaires passent.

**Difficulté rencontrée pendant la vérification** : le pane navigateur ne
compositait pas de frames dans cette session (`screenshot` a échoué avec
"the Browser pane is not displayed"), rendant les clics par coordonnée
(`computer` avec `coordinate`) peu fiables — plusieurs tentatives de
connexion ont tapé le texte dans le mauvais champ. Contourné en utilisant
`form_input` (par `ref`, fiable) pour remplir les champs et
`javascript_tool` pour déclencher les clics de navigation/soumission
lorsque `computer` par `ref` ne suffisait pas — usage exceptionnel pour de
la vérification, pas pour modifier le code de l'app.

**Pas fait / laissé de côté délibérément** :
- Messages WhatsApp générés par `StockPage.tsx` (alertes stock bas et
  péremptions proches envoyées au gérant) — restent en français en dur,
  même statut que les autres documents/communications sortantes
  (tickets, rapports) non encore convertis.
- `RefundModal`/`RefundHistoryModal` couverts, mais aucun autre modal de
  l'app vérifié pour un french-only résiduel similaire — à surveiller page
  par page au fur et à mesure de la conversion du reste de l'app.

### 2026-08-16 — Bilinguisme FR/EN : Produits, Clients, Fournisseurs convertis

**Contexte** : suite du rollout — trois pages CRUD de taille comparable
converties dans la foulée.

**Fait** :
- [SuppliersPage.tsx](apps/web/src/features/suppliers/SuppliersPage.tsx),
  [CustomersPage.tsx](apps/web/src/features/customers/CustomersPage.tsx) et
  [ProductsPage.tsx](apps/web/src/features/products/ProductsPage.tsx)
  entièrement convertis (`suppliers.*`/`customers.*`/`products.*`) :
  formulaires de création/édition, tableaux, ajustement de points fidélité
  (Clients), impression d'étiquettes et champ de taux de TVA conditionnel
  (Produits, `products.taxRate` interpolé avec le taux par défaut).
- **Non traduit délibérément** : `TIER_LABELS` (Bronze/Argent/Or, affiché
  sur `CustomersPage.tsx`) est exporté par `packages/core` — relève du
  chantier "messages métier de `packages/core`" encore à traiter, pas de
  cette page.

**Vérifié dans le navigateur**, pas juste le typecheck : bascule FR→EN sur
les 3 pages (tableaux + formulaires de création ouverts), retour FR
confirmé sur Fournisseurs. Aucune erreur console (hors WebSocket HMR
habituel). `pnpm run build` et les 20 tests unitaires passent.

**Note technique** : dans cette session, les clics par coordonnée
(`computer` action `left_click` avec `coordinate` brut) échouaient de façon
intermittente sans pane visible ; les clics par `ref` (résolus en interne
par le nom d'élément plutôt que la coordonnée figée) se sont montrés
fiables et ont suffi pour toute la vérification de cette passe — pas
besoin de repasser par `javascript_tool` cette fois.

**Pas fait / laissé de côté** : aucun pour ces 3 pages — seul le libellé de
palier fidélité partagé (`TIER_LABELS`, côté `packages/core`) reste en
français, comme documenté ci-dessus.

### 2026-08-16 — Bilinguisme FR/EN : Achats, Créances, Dettes convertis

**Contexte** : suite du rollout — les 3 pages financières restantes liées
aux fournisseurs/clients.

**Fait** :
- Nouveau namespace partagé `common.debtCreditStatus` (Ouverte/Partielle/
  Soldée) réutilisé par [DebtsPage.tsx](apps/web/src/features/debts/DebtsPage.tsx)
  et [CreditsPage.tsx](apps/web/src/features/credits/CreditsPage.tsx) — les
  deux avaient un `STATUS_LABELS` identique dupliqué, fusionné en une seule
  clé plutôt que dupliqué une 3e fois.
- `DebtsPage.tsx`/`CreditsPage.tsx` entièrement convertis (`debts.*`/
  `credits.*`) : tableau, formulaire de paiement inline, bouton "Notifier
  sur WhatsApp" (Créances) — **le message WhatsApp généré par
  `handleNotifyOverdue` reste en français**, même statut que les autres
  communications sortantes non encore converties (voir Stock).
- [PurchasesPage.tsx](apps/web/src/features/purchases/PurchasesPage.tsx)
  entièrement converti (`purchases.*`) : panier d'achat, suggestions de
  réappro (avec interpolation `{{days}}` pour la fenêtre de 30 jours),
  formulaire fournisseur/paiement, historique des achats. `PAYMENT_METHODS`
  déplacé à l'intérieur du composant (même piège récurrent que les sessions
  précédentes).

**Vérifié dans le navigateur**, pas juste le typecheck : bascule FR→EN sur
les 3 pages, retour FR confirmé sur Dettes. Aucune erreur console (hors
WebSocket HMR habituel). `pnpm run build` et les 20 tests unitaires passent.

**Pas fait / laissé de côté** : le message WhatsApp de relance de créance
en retard (`CreditsPage.handleNotifyOverdue`) reste en français en dur,
même raisonnement que les messages WhatsApp de `StockPage.tsx` (journal
précédent) — à traiter avec le lot "documents/communications sortantes".

### 2026-08-16 — Bilinguisme FR/EN : Promotions et Utilisateurs convertis

**Contexte** : suite du rollout — les deux pages restantes de taille
raisonnable avant les 5 plus grosses (Rapports, Comptabilité, Devis,
Tickets de service).

**Fait** :
- [PromotionsPage.tsx](apps/web/src/features/promotions/PromotionsPage.tsx)
  entièrement converti (`promotions.*`) : formulaire de création (portée
  produit/facture, sélection multi-produits avec compteur interpolé
  `{{count}}`), tableau avec badges de statut (Désactivée/En cours/
  Programmée-expirée).
- [UsersPage.tsx](apps/web/src/features/users/UsersPage.tsx) entièrement
  converti (`users.*`) : formulaire de création/édition, tableau,
  impersonation. **Noms de rôle non traduits** (Admin/Propriétaire/Gérant/
  Vendeur/Caissier) — données seedées côté `packages/core`, même statut que
  `TIER_LABELS`.
- **Bug trouvé et corrigé pendant la vérification navigateur** : la colonne
  "Email" du tableau utilisateurs réutilisait par erreur la clé du label de
  formulaire (`users.email` = "Email (optionnel)"), affichant donc
  "EMAIL (OPTIONAL)" en en-tête de colonne. Nouvelle clé dédiée
  `users.emailColumn` = "Email" ajoutée, `UsersPage.tsx` corrigé pour
  l'utiliser sur la colonne du tableau (le label du formulaire garde
  `users.email`).

**Vérifié dans le navigateur**, pas juste le typecheck : compte de test
recréé (OPFS remis à zéro entre deux sessions de preview, voir limitation
connue), module Promotions activé temporairement pour faire apparaître
l'onglet, bascule FR→EN confirmée sur les deux pages (y compris le bug
ci-dessus repéré puis corrigé), retour FR confirmé. Aucune erreur console.
`pnpm run build` (rebuild après le correctif) et les 20 tests unitaires
passent.

**Pas fait / laissé de côté** : aucun pour ces 2 pages, hors les noms de
rôle déjà documentés ci-dessus.

### 2026-08-16 — Bilinguisme FR/EN : Devis converti

**Contexte** : suite du rollout — dernière page de taille raisonnable
avant les 3 plus grosses restantes (Rapports, Comptabilité, Tickets de
service).

**Fait** :
- [QuotesPage.tsx](apps/web/src/features/quotes/QuotesPage.tsx) entièrement
  converti (`quotes.*`) : panier d'articles, bloc client/validité avec
  totaux, tableau des devis enregistrés avec badges de statut (En attente/
  Accepté/Expiré/Converti), panneau de conversion en vente inline.
  `PAYMENT_METHODS` du panneau de conversion réutilise
  `t("sales.paymentMethods.*")` (mêmes 4 valeurs cash/card/mobile_money/
  credit déjà traduites pour Ventes) plutôt que de dupliquer une 3e fois —
  contrairement aux sessions précédentes qui avaient dupliqué ces libellés
  par page.
- Contenu du PDF de devis (`buildQuotePdf`, libellé "Article" par défaut
  pour une ligne sans nom de produit) volontairement non touché — relève du
  chantier "documents" (`packages/printer`), pas de cette page.

**Vérifié dans le navigateur**, pas juste le typecheck : bascule FR→EN
confirmée (panier vide, bloc client/validité, tableau devis vide), retour
FR confirmé. Aucune erreur console (hors WebSocket HMR habituel).
`pnpm run build` et les 20 tests unitaires passent.

**Pas fait / laissé de côté** : pas de vérification d'un devis réel avec
articles/statuts/conversion (aurait nécessité de recréer un produit sur le
compte de test fraîchement réinitialisé) — code structurellement identique
aux pages déjà vérifiées avec données réelles (Achats, Ventes), risque jugé
faible.

### 2026-08-16 — Bilinguisme FR/EN : Comptabilité convertie

**Contexte** : suite du rollout — avant-dernière page de taille
raisonnable, les 2 restantes (Rapports, Tickets de service) sont les plus
grosses de l'app.

**Fait** :
- [AccountingPage.tsx](apps/web/src/features/accounting/AccountingPage.tsx)
  entièrement converti (`accounting.*`) : les 3 onglets (Compte de
  résultat/Bilan/Export SYSCOHADA), l'avertissement SYSCOHADA (perte
  cosmétique mineure acceptée — le `<strong>` en début de paragraphe
  fusionné dans une seule clé de texte, même tradeoff que
  `settings.maintenance.updateWarning` en session précédente), les 4
  sous-vues SYSCOHADA (Journal des ventes/achats/trésorerie, Balance
  générale) et leurs tableaux.
- **Titres de document traduits, contrairement à la convention habituelle** :
  `SYSCOHADA_TITLES` (passé tel quel à `buildSyscohadaJournalPdf`/`Excel`
  comme titre du document exporté) a été traduit via `accounting.titles.*`
  — décision délibérée différente du traitement des autres documents
  (reçus, tickets) laissés en français : ce titre est construit dans le
  code de la page elle-même (pas un gabarit figé dans `packages/printer`/
  `packages/reports`), donc le traduire coûtait la même chose que traduire
  le reste de la page.

**Vérifié dans le navigateur**, pas juste le typecheck : module SYSCOHADA
activé temporairement, bascule FR→EN confirmée sur les 3 onglets (y compris
la sous-vue "Balance générale" du SYSCOHADA), retour FR confirmé. Aucune
erreur console (hors WebSocket HMR habituel). `pnpm run build` et les 20
tests unitaires passent.

**Pas fait / laissé de côté** : aucun pour cette page.

### 2026-08-16 — Bilinguisme FR/EN : Rapports converti

**Contexte** : suite du rollout — avant-dernière page, ne reste ensuite que
Tickets de service (la plus grosse page de l'app).

**Fait** :
- [ReportsPage.tsx](apps/web/src/features/reports/ReportsPage.tsx)
  entièrement converti (`reports.*`) : les 6 onglets (Ventes/Marges/
  Trésorerie/Caisse/Tickets de service/TVA, les 2 derniers gated par
  module comme avant), filtres date/boutique, cartes KPI, graphiques
  (labels via `t()`, y compris les libellés d'années `"An {{year}}"` du
  graphique de projection de trésorerie), tableaux et boutons d'export
  PDF/Excel de chacun. `PAYMENT_STATUS_LABELS` (utilisé sur l'onglet
  Tickets de service) réutilise `common.paymentStatus.*` déjà existant
  plutôt que dupliquer une nouvelle fois.
- **Composant partagé non traduit, repéré pendant la conversion** :
  [SimpleChart.tsx](apps/web/src/components/SimpleChart.tsx) (utilisé par
  tous les graphiques de Rapports via `BarChart`/`LineChart`) a son propre
  texte "Aucune donnée pour cette période." codé en dur, non touché cette
  session — même situation que `FilterBar` avant sa conversion (voir
  journal 2026-08-15), mais Rapports est pour l'instant le seul
  consommateur du composant donc l'effet de bord reste local à cette page.

**Vérifié dans le navigateur**, pas juste le typecheck : bascule FR→EN
confirmée sur les 4 onglets accessibles sans module supplémentaire (Ventes/
Marges/Trésorerie/Caisse, y compris la table de projection de trésorerie
avec ses libellés d'année interpolés), retour FR confirmé. Aucune erreur
console (hors WebSocket HMR habituel). `pnpm run build` et les 20 tests
unitaires passent.

**Pas fait / laissé de côté** : les onglets TVA et Tickets de service
(gated par les modules `taxEnabled`/`enableServiceOrders`) n'ont pas pu être
vérifiés en direct dans le navigateur cette session — l'activation de ces
deux modules depuis Paramètres pendant la vérification ne persistait pas.
**Correctif** : fausse alerte, cause identifiée et corrigée dans la session
suivante — voir piste 6 ci-dessous (c'était un piège du script de
vérification, pas un bug de l'app).

### 2026-08-16 — Bilinguisme FR/EN : Tickets de service converti (dernière page)

**Contexte** : dernière page de l'app à convertir — `ServiceOrdersPage.tsx`
(~1000 lignes, la plus grosse page), ce qui clôt le rollout "pages" du
bilinguisme FR/EN.

**Fait** :
- [ServiceOrdersPage.tsx](apps/web/src/features/serviceOrders/ServiceOrdersPage.tsx)
  entièrement converti (`serviceOrders.*`) : les 3 vues (Nouveau ticket/
  Suivi/Historique), le panier d'articles en saisie libre, le bloc client/
  paiement, le suivi de statut par article avec notification WhatsApp
  (message généré non traduit, même statut que les autres communications
  sortantes), le remboursement de solde à crédit, et la vue Historique
  (correction d'un ticket déjà créé). Trois `Record` de libellés de statut
  distincts (`itemStatus`, `aggregateStatus`, `paymentStatus`) — non
  fusionnés malgré des valeurs qui se recoupent partiellement, car indexés
  par des unions de types différentes (`ServiceOrderItemStatus` vs
  `ServiceOrderAggregateStatus`) et `paymentStatus` a un accord grammatical
  différent de `common.paymentStatus` ("Payé"/"Partiel", masculin car
  accordé avec "ticket", contre "Payée"/"Partielle" dans `common.*`,
  accordé avec "vente") — vérifié explicitement dans le navigateur (voir
  ci-dessous) pour confirmer que la réutilisation aurait été fausse.
  `PAYMENT_METHODS` réutilise `sales.paymentMethods.*` (mêmes 4 valeurs).
- **Bug de clé repéré et corrigé pendant l'écriture** : le champ client
  "Client" de la vue Historique réutilisait par erreur
  `t("quotes.noCustomerOption")` ("— Aucun / nouveau —", pensé pour Devis)
  au lieu du texte correct pour ce contexte d'édition ("— Aucun —", sans
  option "nouveau" puisqu'on modifie un ticket existant) — nouvelle clé
  dédiée `serviceOrders.noCustomerEditOption` ajoutée avant même la
  vérification navigateur (repéré en relisant le diff).

**Vérifié dans le navigateur**, pas juste le typecheck, avec des données
réelles cette fois (pas seulement des vues vides) : module Tickets de
service activé (voir piste 6 pour le vrai correctif de méthode de
vérification qui a débloqué ça), ticket TCK-2026-000001 créé avec un
article réel, bascule FR→EN confirmée sur les 3 vues y compris le message
de confirmation post-création, le suivi de statut par article ("Received/
In progress/Ready/Picked up"), et le panneau de correction de la vue
Historique avec ses données réelles. Retour FR confirmé, y compris l'accord
grammatical correct "Payé" (masculin). Aucune erreur console (hors
WebSocket HMR habituel). `pnpm run build` et les 20 tests unitaires
passent.

**Pas fait / laissé de côté** : le message WhatsApp de notification "ticket
prêt" (`handleStatusChange`-adjacent, dans la vue Suivi) reste en français
en dur, même statut que les autres communications sortantes non converties
(Stock, Créances) — à traiter avec le lot "documents/communications
sortantes".

**Avec cette page, toutes les pages de l'app sont désormais bilingues FR/EN.**
Reste : les messages d'erreur métier de `packages/core`, les documents
(tickets/rapports), l'écran de connexion, et le composant `SimpleChart` —
voir Prochaines pistes.

### 2026-08-16 — Bilinguisme FR/EN : écran de connexion (AuthGate) converti

**Contexte** : dernier morceau du périmètre "Interface" du chantier
bilinguisme — l'écran de connexion, explicitement laissé de côté depuis le
tout premier lot (2026-08-15) car non atteignable depuis le sélecteur de
langue du `TopBar` (qui ne s'affiche qu'une fois connecté). Repris
maintenant que toutes les pages post-connexion sont converties.

**Fait** — les 6 écrans de
[apps/web/src/features/auth/](apps/web/src/features/auth/) convertis
(`auth.*`) :
- `LoginScreen.tsx` (`auth.login.*`).
- `SetupAdminScreen.tsx` (`auth.setupAdmin.*`) — écran de création du tout
  premier compte administrateur.
- `ModuleSetupScreen.tsx` (`auth.moduleSetup.*`) — écran affiché une seule
  fois juste après. Les 6 libellés de module réutilisent
  `settings.modules.*` déjà traduits (même liste que Paramètres → Modules
  actifs) plutôt que d'être dupliqués — au passage, le libellé Tickets de
  service légèrement raccourci de cet écran ("...pressing, cordonnerie...")
  s'aligne maintenant sur la version complète de Paramètres ("...pressing,
  cordonnerie, couture, réparation..."), un léger changement de texte
  assumé pour éviter la duplication.
- `PinLockScreen.tsx` (`auth.pinLock.*`) — titre et bouton de déconnexion ;
  le clavier numérique lui-même (chiffres, ⌫) n'a pas de texte à traduire.
- `ChangePasswordModal.tsx` (`auth.changePassword.*`).
- `AuthGate.tsx` lui-même : les deux écrans "Chargement..." intermédiaires
  (`auth.loading`).

**Vérifié dans le navigateur**, pas juste le typecheck : connexion → bascule
FR→EN via TopBar → déconnexion → écran de connexion confirmé en anglais
("Login/Username/Password/Sign in", résout directement la limitation notée
au 2026-08-15 où l'écran restait en français après un rechargement malgré
la langue EN active) → reconnexion → verrouillage de session → écran PIN
confirmé en anglais ("Session locked"/"Log out") → code PIN volontairement
faux saisi pour vérifier qu'une erreur venant de `packages/core`
("Code PIN incorrect") s'affiche bien encore en français au milieu d'un
écran en anglais — comportement attendu et documenté (messages d'erreur
métier non encore convertis, voir Prochaines pistes) plutôt qu'un bug de
cette conversion. Modale "Change my password" ouverte et confirmée
traduite. Retour FR confirmé. Aucune erreur console (hors WebSocket HMR
habituel). `pnpm run build` et les 20 tests unitaires passent.

**Pas fait / laissé de côté** : aucun pour ces 6 écrans.

**Avec cet écran, le périmètre "Interface" du chantier bilinguisme est
intégralement couvert** (toutes les pages + tout l'écran de connexion).
Reste le périmètre "documents" (tickets ESC/POS/PDF, rapports Excel/PDF) et
les messages d'erreur métier de `packages/core` pour compléter le périmètre
initial ("Interface + documents") validé au lancement du chantier — voir
Prochaines pistes.

### 2026-08-17 — Bilinguisme FR/EN : messages d'erreur métier de `packages/core`

**Contexte** : premier morceau du périmètre "documents"/logique métier du
chantier bilinguisme (le périmètre "Interface" étant intégralement couvert
depuis la session précédente) — les messages levés par `throw new
Error("...")` dans `packages/core` restaient en français en dur quelle que
soit la langue de l'UI, comme observé et documenté pendant la vérification
de l'écran PIN le 2026-08-16 ("Code PIN incorrect" affiché en français au
milieu d'un `PinLockScreen` en anglais).

**Fait** :
- `packages/core` n'avait jusqu'ici jamais consommé `@gestion-boutique/i18n`
  (seulement documenté/prévu) — ajouté à ses `dependencies`
  (`"@gestion-boutique/i18n": "workspace:*"`) puis `pnpm install` pour créer
  le lien du workspace. Chaque fichier concerné importe directement
  `import { t } from "@gestion-boutique/i18n";` et l'appelle au point
  d'usage (`throw new Error(t("coreErrors...."))`), sans faire transiter de
  langue ni de fonction `t` à travers les signatures de service — même
  principe déjà documenté dans la section *Internationalisation* ci-dessus,
  exercé ici pour la première fois côté non-React.
- **62 messages convertis** au namespace `coreErrors.<service>.*` (+
  `coreErrors.common.*` pour 3 messages réutilisés tels quels par plusieurs
  services : `tooManyAttempts`, `amountExceedsBalance`,
  `insufficientLoyaltyPoints`), répartis sur 14 fichiers :
  `auth/AuthService.ts`, `domain/permissions.ts` (message par défaut de
  `PermissionError`, sûr car un paramètre par défaut s'évalue à l'appel, pas
  au chargement du module), et les services `Backup`, `Credits`, `Debts`,
  `Loyalty`, `Maintenance`, `Products`, `Promotions`, `Purchases`, `Quotes`,
  `Refunds`, `Sales`, `ServiceOrders`, `Stores`.
- **`TIER_LABELS`** (`Record<LoyaltyTier, string>` statique exporté par
  `LoyaltyService.ts`) remplacé par une fonction `getTierLabel(tier)` qui
  appelle `t()` à chaque invocation — un objet figé au chargement du module
  ne suivrait jamais un changement de langue en cours de session (même piège
  que les listes d'options traduites côté UI — `FREQUENCY_PRESETS`,
  `PAYMENT_METHODS`, etc. — déplacées à l'intérieur du composant à chaque
  fois qu'il s'est reproduit cette session). `CustomersPage.tsx` mis à jour
  pour appeler `getTierLabel(tier)` au lieu d'indexer l'ancien objet.
- **Volontairement pas touché : `DEFAULT_ROLES`** (`permissions.ts`, noms de
  rôle seedés Admin/Propriétaire/Gérant/Vendeur/Caissier) — ces noms sont
  persistés dans la table `roles` par `RolesService.ensureDefaultRoles()` et
  servent à des comparaisons d'égalité ailleurs (`roles.find(r => r.name ===
  ...)` dans `UsersPage.tsx`) : les traduire changerait la donnée stockée
  elle-même, pas juste son affichage, et casserait ces comparaisons.
  Confirmé en anglais dans le navigateur : la liste déroulante de rôle du
  formulaire "New user" affiche bien encore "Admin, Propriétaire, Gérant,
  Vendeur, Caissier" (français) même avec l'UI en anglais — attendu, pas un
  bug de cette session. Nécessitera une vraie stratégie d'affichage (mapping
  nom-stocké → clé de traduction), différente du simple remplacement par
  `t()` utilisé partout ailleurs cette session — laissé pour une session
  dédiée.
- Confirmé par `Grep` (`throw new Error\("[À-ÿ]` sur `packages/core/src/**/*.ts`)
  qu'aucun message français en dur ne subsiste.

**Vérifié dans le navigateur**, pas juste le typecheck : bascule EN, page
Utilisateurs → tentative de création d'un compte avec le pseudo `admin`
(déjà pris) → message "This username is already in use." confirmé en
anglais (`coreErrors.auth.usernameTaken`) ; page Clients → création d'un
client de test → colonne Palier affiche "Bronze" via `getTierLabel` (mot
identique en FR/EN, mais confirme que la fonction s'exécute et résout bien
la clé `loyaltyTiers.bronze`) ; retour FR confirmé. Aucune erreur console
(hors WebSocket HMR habituel). `pnpm run build` et les 20 tests unitaires
passent (aucun test n'asserte sur le texte des messages d'erreur — confirmé
par `Grep` sur `toThrow|\.message` dans `packages/core/src/**/*.test.ts`
avant la conversion, zéro résultat).

**Pas fait / laissé de côté** :
- `DEFAULT_ROLES` (voir ci-dessus) — nécessite une stratégie dédiée.
- Pas re-testé spécifiquement le PIN incorrect (`AuthService` ne lève pas
  d'erreur pour un PIN invalide — à vérifier lequel des messages
  `coreErrors.auth.*` correspondait réellement au "Code PIN incorrect" vu au
  2026-08-16 ; les scénarios testés cette session (pseudo déjà pris, palier
  fidélité) suffisent à valider le mécanisme `t()` dans `packages/core`,
  mais un balayage exhaustif des 62 messages un par un n'a pas été fait).
- `SimpleChart.tsx`, messages WhatsApp, documents `packages/printer`/
  `packages/reports` : toujours pas convertis, voir Prochaines pistes.

### 2026-08-17 — Bilinguisme FR/EN : `SimpleChart` et messages WhatsApp convertis

**Contexte** : suite immédiate de la session précédente — les deux derniers
morceaux du périmètre "documents"/logique-métier-côté-client avant le plus
gros chantier restant (`packages/printer`/`packages/reports`) : le composant
partagé `SimpleChart` (repéré non traduit pendant la conversion de Rapports,
2026-08-16) et les 5 messages WhatsApp générés côté client (Stock, Créances,
Ventes, Tickets de service).

**Fait** :
- [SimpleChart.tsx](apps/web/src/components/SimpleChart.tsx) (`BarChart`/
  `LineChart`) : le texte "Aucune donnée pour cette période." affiché quand
  `data.length === 0` remplacé par `t("common.noChartData")` via
  `useTranslation()` — nouvelle clé dans le namespace `common` déjà existant
  (partagé avec `paymentStatus`/`filterBar`/`debtCreditStatus`) plutôt qu'un
  nouveau namespace pour une seule clé.
- Nouveau namespace `whatsapp.*` dans les dictionnaires, couvrant les 5
  messages :
  - [lib/whatsapp.ts](apps/web/src/lib/whatsapp.ts) : `buildReceiptWhatsAppMessage`
    (reçu de vente) est une fonction pure, pas un composant — appelle `t()`
    importé directement depuis `@gestion-boutique/i18n` (même principe que
    `packages/core`, voir journal 2026-08-17 précédent), plutôt que de faire
    remonter `t` en paramètre depuis `SalesPage.tsx`. `WHATSAPP_PAYMENT_LABELS`
    (dupliquait `sales.paymentMethods.*`) supprimé, remplacé par
    `t(\`sales.paymentMethods.${method}\`, { defaultValue: method })` —
    réutilise la clé déjà traduite plutôt que d'en dupliquer une 4e fois.
  - `StockPage.handleNotifyLowStock`/`handleNotifyExpiring`, `CreditsPage.handleNotifyOverdue`,
    et le message d'avis "ticket prêt" inline de `ServiceOrdersPage.tsx` :
    tous les 4 sont dans des composants qui avaient déjà `t` via
    `useTranslation()` — conversion directe, aucun nouvel import.
  - Le mot de repli "nous" (ex. "chez nous" quand `businessSettings.businessName`
    est vide) devient sa propre clé `whatsapp.defaultBusinessName` plutôt
    qu'un fragment figé dans le template, car "chez {{business}}"/
    "at {{business}}" diffère par sa préposition entre les deux langues — le
    template entier (pas juste le mot de repli) est donc traduit par langue.

**Vérifié dans le navigateur**, pas juste le typecheck : compte de test
recréé (OPFS remis à zéro entre deux sessions de preview, voir limitation
connue), bascule EN, produit de test créé avec un seuil d'alerte stock bas
(5) et 0 en stock pour faire apparaître le bouton "Notify via WhatsApp" sur
Stock — lien `wa.me` intercepté (`window.open` remplacé), texte confirmé :
*"Low stock alert — 1 product(s) to restock at WariBox Test Shop:\n-
Test Widget: 0/5"*. Onglet Rapports → Ventes vérifié en anglais : "No data
for this period." (`common.noChartData`) s'affiche bien sous "Revenue by
day" (aucune vente sur la période, donc graphique vide). Retour FR confirmé
sur le même bouton Stock ("Notifier sur WhatsApp") : texte reproduit à
l'identique du message d'origine (*"Alerte stock bas — 1 produit(s) à
réapprovisionner chez WariBox Test Shop :\n- Test Widget : 0/5"*), confirmant
qu'aucune régression n'a été introduite côté français. Aucune erreur
console. `pnpm run build` et les 20 tests unitaires passent.

**Pas fait / laissé de côté** :
- Pas de vérification directe des messages Créances (`handleNotifyOverdue`)
  et Tickets de service (avis "prêt à récupérer") avec des données réelles
  (aurait nécessité de créer un client avec téléphone + une créance en
  retard, ou un ticket de service au statut "Prêt") — code structurellement
  identique au message Stock déjà vérifié bout en bout (même fonction
  `buildWhatsAppLink`, mêmes clés `t()` interpolées), risque jugé faible.
  Idem pour le reçu de vente WhatsApp (`buildReceiptWhatsAppMessage`) — sa
  conversion en `t()` a été vérifiée par le build/typecheck mais pas
  déclenchée dans le navigateur cette session.
- Reste, pour clore le périmètre "documents" du chantier bilinguisme :
  `DEFAULT_ROLES` (stratégie d'affichage dédiée nécessaire) et le contenu
  des documents `packages/printer`/`packages/reports` (le plus gros
  morceau restant).

### 2026-08-17 — Bilinguisme FR/EN : documents `packages/printer`/`packages/reports` convertis (dernier morceau du chantier)

**Contexte** : dernier morceau du périmètre initial "Interface + documents"
du chantier bilinguisme — le contenu des documents générés par
`packages/printer` (tickets ESC/POS + PDF, devis) et `packages/reports`
(rapports PDF/Excel), jusqu'ici toujours en français en dur quelle que soit
la langue de l'UI (confirmé pendant la vérification de Historique des ventes
au 2026-08-15 : le PDF "Rapport" restait en français avec l'UI en anglais).

**Fait** :
- `@gestion-boutique/i18n` ajouté aux `dependencies` de `packages/printer`
  et `packages/reports` (aucun des deux ne l'utilisait avant), `pnpm install`
  pour créer les liens de workspace — même mécanique que `packages/core`
  (2026-08-17 précédent), `t()` importé et appelé directement au point
  d'usage, sans faire transiter de langue/fonction à travers les signatures.
- Nouveau namespace `documents.*` dans les dictionnaires :
  - `documents.common.*` : les tokens réellement partagés entre reçu/bon de
    dépôt/devis (téléphone, client, sous-total, remise, TVA incluse, total,
    "Ticket {{number}}").
  - `documents.receipt.*` (caissier, ligne de paiement, remerciement),
    `documents.serviceTicket.*` (titre "BON DE DEPOT", téléphone client,
    date de retrait prévue, payé, solde dû, phrase de conservation du
    ticket), `documents.quote.*` (titre, date, validité, 4 en-têtes de
    colonnes).
  - `documents.reports.*`, un sous-objet par rapport (`sales`, `margins`,
    `cashFlow`, `incomeStatement`, `tax`, `balanceSheet`, `syscohadaJournal`,
    `syscohadaBalance`, `cashSessions`) — chacun avec son titre, son
    sous-titre (chaîne unique interpolée avec des paramètres nommés, même
    principe que les messages WhatsApp composés de la session précédente,
    plutôt que concaténer des fragments qui casseraient l'ordre des mots
    d'une langue à l'autre), ses en-têtes de colonnes PDF, et un sous-objet
    `excel.*` pour les noms d'onglet et les clés d'objet JS qui deviennent
    littéralement les en-têtes de colonnes Excel (`{ [t("...")]: valeur }`).
  - [receipt.ts](packages/printer/src/receipt.ts)/[receiptPdf.ts](packages/printer/src/receiptPdf.ts) :
    `PAYMENT_LABELS` (dupliquait `sales.paymentMethods.*` une 5e fois, après
    la duplication déjà supprimée de `whatsapp.ts` la session précédente)
    supprimé, remplacé par `t(\`sales.paymentMethods.${method}\`, {
    defaultValue: method })`.
  - [pdf.ts](packages/reports/src/pdf.ts)/[excel.ts](packages/reports/src/excel.ts) :
    `buildSyscohadaJournalPdf`/`Excel` gardent `data.title` tel quel (déjà
    traduit côté appelant via `accounting.titles.*`, voir session
    2026-08-16) — seul le sous-titre et les en-têtes de colonnes sont
    convertis ici, pas le titre.
  - [labelsPdf.ts](packages/printer/src/labelsPdf.ts) : vérifié, aucun texte
    d'interface en dur (juste nom/prix/code-barres du produit, données) —
    rien à convertir.
- Confirmé par `Grep` (recherche de chaînes contenant des caractères
  accentués dans les deux packages) qu'aucun texte français en dur ne
  subsiste dans `packages/printer/src`/`packages/reports/src`.

**Vérifié dans le navigateur**, pas juste le typecheck — et pas seulement le
texte visible de l'UI cette fois, mais le **contenu réel des PDF générés** :
en interceptant `URL.createObjectURL` (utilisé par le helper `downloadBlob`
partagé de chaque page d'export) pour capturer le `Blob` avant son
téléchargement, puis en décodant ses octets bruts en `latin1` — jsPDF
n'active pas la compression de flux par défaut ici (aucun appel ne passe
`{ compress: true }`), donc le texte apparaît en clair dans le PDF et est
directement cherchable par sous-chaîne, sans bibliothèque d'extraction PDF :
- Rapport Ventes (Rapports → Ventes → Export PDF) en anglais : présence
  confirmée de "Sales report" (titre), et du sous-titre interpolé complet
  *"From 2026-07-18 to 2026-08-17 — Total revenue: 0 — Sales: 0 — Average
  basket: 0"* (aucune valeur manquante/`undefined`), plus les 3 en-têtes de
  colonnes.
- Reçu de vente réel (vente test VTE-2026-000001, 1 unité à 1000) en
  anglais via "Save as PDF" : *"Receipt VTE-2026-000001"*, *"Cashier: Admin
  Test"*, *"Payment (Cash): 1000"* (parenthèses échappées `\(`/`\)` par
  jsPDF, correctement décodées), *"Thank you for your visit"* tous présents.
  **Même reçu régénéré en français** après retour FR : *"Ticket
  VTE-2026-000001"*, *"Caissier : Admin Test"*, *"Paiement (Espèces)"*,
  *"Merci de votre visite"* — texte français identique à l'original,
  confirmant l'absence de régression.
- Export Excel (Rapports → Ventes → Export Excel) : blob `.xlsx` valide
  généré sans erreur (type MIME et taille cohérents) — contenu des colonnes
  non extrait (pas de bibliothèque de lecture xlsx disponible côté
  navigateur pour cette vérification), mais mécanisme `t()` déjà validé à
  l'identique par les PDF ci-dessus (mêmes clés, même `t()`).

Aucune erreur console à aucune étape (hors WebSocket HMR habituel).
`pnpm run build` (build complet du monorepo, ~4 min) et les 20 tests
unitaires passent.

**Pas fait / laissé de côté** :
- Contenu réel non extrait pour les fichiers `.xlsx` (voir ci-dessus) ni
  pour les tickets ESC/POS bruts (`buildReceipt`/`buildServiceOrderTicket`,
  format binaire imprimante — jamais généré ni vérifié dans le navigateur
  faute d'imprimante physique connectée à cette machine ; code
  structurellement identique aux versions PDF déjà vérifiées, mêmes clés
  `t()`, risque jugé faible).
- Pas de vérification du devis PDF (`quotePdf.ts`) ni du bon de dépôt de
  ticket de service (`buildServiceOrderTicketPdf`) avec des données réelles
  cette session — même raisonnement de risque faible (code structurellement
  identique au reçu de vente déjà vérifié bout en bout).
- `DEFAULT_ROLES` (`permissions.ts`) reste le seul point non converti de
  tout le chantier bilinguisme — nécessite une stratégie d'affichage dédiée
  (mapping nom-stocké → clé de traduction), pas un simple remplacement par
  `t()`, voir journal 2026-08-17 précédent.

**Avec cette conversion, le périmètre initial "Interface + documents" du
chantier bilinguisme FR/EN, lancé le 2026-08-15, est intégralement
couvert.** Seul `DEFAULT_ROLES` reste non traduit (affichage uniquement,
sans impact sur les données stockées elles-mêmes).

### 2026-08-17 — Bilinguisme FR/EN : `DEFAULT_ROLES` (dernier point du chantier, désormais clos)

**Contexte** : dernier point resté explicitement en suspens depuis
l'audit du chantier bilinguisme (journal 2026-08-17 précédent, "messages
d'erreur métier de `packages/core`") — les 5 noms de rôle seedés
(Admin/Propriétaire/Gérant/Vendeur/Caissier) sont **persistés en base**
(table `roles`, écrits par `RolesService.ensureDefaultRoles`) et servent à
des comparaisons d'égalité (`UsersPage.tsx` : `roles.find(r => r.name ===
target.roleName)`) — donc, contrairement à tout le reste du chantier, un
simple remplacement du texte source par `t()` aurait changé la donnée
stockée elle-même et cassé ces comparaisons.

**Fait** — stratégie d'affichage dédiée plutôt qu'un remplacement de texte :
- [permissions.ts](packages/core/src/domain/permissions.ts) : nouvelle
  fonction `getRoleDisplayName(storedName: string): string` — construit une
  table de correspondance inverse (`ROLE_NAME_TO_KEY`, nom stocké → clé
  `DefaultRoleKey`, dérivée de `DEFAULT_ROLES` lui-même pour ne jamais
  désynchroniser les deux) puis résout `t(\`roles.${key}\`)`. **Le nom
  stocké en base n'est jamais modifié** — seul l'affichage passe par cette
  fonction, appelée à chaque rendu (même principe que `getTierLabel`, voir
  journal 2026-08-17 précédent : une table figée au chargement du module ne
  suivrait pas un changement de langue en cours de session, mais ici c'est
  la *fonction de résolution* elle-même qui est appelée à chaque rendu, pas
  une valeur mise en cache). Un nom non reconnu (rôle personnalisé
  hypothétique, aucune UI ne permet aujourd'hui d'en créer un) est retourné
  tel quel — c'est une donnée saisie par l'utilisateur, pas du texte
  d'interface, donc pas traduisible.
- Nouveau namespace `roles.*` dans les dictionnaires : `admin`, `proprietaire`,
  `gerant`, `vendeur`, `caissier`. Traductions anglaises choisies pour rester
  des intitulés de poste naturels plutôt que des calques littéraux :
  Propriétaire→Owner, Gérant→Manager, Vendeur→Salesperson, Caissier→Cashier
  (Admin reste Admin dans les deux langues).
- 3 points d'affichage convertis, les seuls trouvés par `Grep` sur
  `roleName`/`role.name` dans `apps/web/src` :
  [TopBar.tsx](apps/web/src/features/auth/TopBar.tsx) (badge de rôle à côté
  du nom de l'utilisateur connecté, visible sur toutes les pages),
  [UsersPage.tsx](apps/web/src/features/users/UsersPage.tsx) (colonne Rôle
  du tableau, et le texte des `<option>` de la liste déroulante de rôle du
  formulaire de création/édition). **Le seul autre point qui lit
  `roleName`** — la résolution du rôle sélectionné en édition
  (`roles.find((r) => r.name === target.roleName)`, ligne 103 de
  `UsersPage.tsx`) — **volontairement pas touché**, comparaison d'égalité
  sur la valeur réelle stockée.

**Vérifié dans le navigateur**, pas juste le typecheck : bascule EN, page
Utilisateurs → formulaire "+ New user" → liste déroulante de rôle confirmée
*"Admin, Owner, Manager, Salesperson, Cashier"* (au lieu des noms français
bruts affichés avant ce correctif) ; retour FR confirmé → même liste
déroulante revérifiée *"Admin, Propriétaire, Gérant, Vendeur, Caissier"*,
identique au texte d'origine (pas de régression). Aucune erreur console
(hors WebSocket HMR habituel). `pnpm run build` et les 20 tests unitaires
passent.

**Pas fait / laissé de côté** : aucun — c'était le tout dernier point
identifié du chantier bilinguisme.

**Avec ce correctif, le chantier bilinguisme FR/EN démarré le 2026-08-15
est intégralement terminé** sur son périmètre initial
("Interface + documents") : plus aucun texte français en dur ne subsiste
dans l'interface, les messages d'erreur métier, les messages WhatsApp, les
documents imprimés/exportés, ni l'affichage des rôles.

### 2026-08-17 — Bilinguisme FR/EN : re-vérification complète, 6 trous supplémentaires trouvés et corrigés

**Contexte** : demande explicite de re-vérifier que tout le chantier
bilinguisme est solide et que rien n'est cassé, plutôt que de faire
confiance aux déclarations "terminé" des sessions précédentes. Plutôt qu'un
simple re-test des scénarios déjà vérifiés, écrit un script Node ponctuel
(scratchpad, pas commité) qui : (1) valide le JSON des deux dictionnaires,
(2) compare l'ensemble des clés FR/EN pour détecter toute clé manquante
d'un côté, (3) extrait tous les appels `t("...")` littéraux du code et
vérifie que chaque clé existe bien dans `fr.json`, (4) balaie tout le code
(`apps/web/src`, tous les `packages/*/src`) à la recherche de texte
contenant des caractères accentués français en dehors des commentaires.

**Bug méthodologique découvert en cours de route** : le tout premier balayage
(motif regex `[À-ÿ]{3,}`, utilisé début de session pour vérifier
`packages/printer`) ne trouvait "aucune correspondance" sur des fichiers qui
contenaient pourtant des chaînes accentuées bien réelles — confirmé en
re-testant le même motif sur le même fichier après coup : toujours aucune
correspondance, alors qu'une recherche littérale sur le texte exact trouvait
les lignes sans problème. Cause non élucidée précisément (probablement une
particularité du moteur regex de l'outil de recherche sur les classes de
caractères Unicode combinées à un quantificateur `{3,}}`), mais **le
résultat "aucune correspondance" de ce motif s'est révélé non fiable** —
d'où le script Node de cette session, qui fait une recherche caractère-par-
caractère explicite plutôt que de compter sur un seul motif regex.

**7 trous réels trouvés et corrigés** (tous vérifiés dans le navigateur,
pas seulement le typecheck) :

1. **`packages/printer/src/PrinterService.ts` + `transport.ts`** — 5 messages
   d'erreur matériel imprimante (Bluetooth/USB) jamais convertis
   (`printerErrors.*`).
2. **`apps/web/src/features/printer/usePrinter.ts` +
   `PrinterPanel.tsx`** — **composant entier jamais traduit** (titre, statut,
   boutons Connecter/Déconnecter/Ouvrir le tiroir, messages d'indisponibilité
   Bluetooth/USB). Repéré parce qu'il est caché derrière le bouton
   "Imprimante"/"Printer" de la page Ventes — jamais ouvert pendant les
   vérifications précédentes malgré des dizaines de passages sur cette page
   (namespace `printer.*`).
3. **`apps/web/src/app/DatabaseProvider.tsx`** — écran d'erreur/chargement de
   la base locale (`database.*`) — traduit sauf le `console.error` et
   l'erreur de mésusage de `useDatabase()` hors provider, qui restent
   volontairement en français (jamais vus par un utilisateur, uniquement des
   diagnostics développeur/erreurs de programmation, même traitement que
   `logo.ts` ci-dessous).
4. **`apps/web/src/components/SearchableSelect.tsx`** — "Aucun résultat"
   (`common.noResults`), composant partagé utilisé par la quasi-totalité des
   sélecteurs produit/client/fournisseur de l'app.
5. **`apps/web/src/components/UpdateBanner.tsx`** — bannière de mise à jour
   PWA, jamais traduite malgré le composant lui-même bien identifié dans le
   journal du 2026-08-14 comme "a son propre vrai mécanisme de mise à jour,
   sans rapport avec Paramètres" — cette remarque portait sur le mécanisme,
   pas sur son texte, qui était resté non converti (`updateBanner.*`).
6. **`apps/web/src/features/sales/BarcodeCameraScanner.tsx`** — permission
   caméra refusée, échec d'accès caméra, instructions, bouton Fermer
   (`sales.scanner.*`).
7. **`apps/web/src/features/settings/backupRunner.ts`** — 2 erreurs de
   sauvegarde locale ("Aucun dossier choisi", "Permission refusée",
   `settings.backups.errors.*`).
8. **`apps/web/src/features/auth/useAuth.ts`** — **la cause racine réelle du
   "Code PIN incorrect" observé en français depuis le 2026-08-16**, alors que
   la session du 2026-08-17 précédente avait converti les 62 messages
   d'erreur de `packages/core` en pensant (à tort) que le message venait de
   là. En réalité `useAuth.ts` (`apps/web`, pas `packages/core`) lève
   lui-même 3 messages en dur ("Identifiants incorrects", "Aucune session
   active", "Code PIN incorrect") — jamais repérés par le balayage du
   2026-08-17 précédent car limité à `packages/core/src`. Cette fois
   converti (`auth.errors.*`) et **vérifié en conditions réelles** :
   verrouillage de session → PIN volontairement faux → "Incorrect PIN" en
   anglais confirmé, puis re-testé en français → "Code PIN incorrect"
   identique au texte d'origine.
9. **`packages/sync/src/googleDrive.ts`** — 6 messages d'erreur de connexion/
   upload Google Drive (`sync.errors.*`), package jamais touché par le
   chantier bilinguisme jusqu'ici (pas de dépendance à `@gestion-boutique/i18n`
   avant cette session).

**Second trou structurel, de la même famille que `DEFAULT_ROLES`** :
**`DEFAULT_LOCATIONS`** ([domain/stock.ts](packages/core/src/domain/stock.ts))
— les noms d'emplacement seedés "Réserve"/"Surface de vente" étaient
affichés bruts (non traduits) dans **6 endroits de `StockPage.tsx`**
(filtre, en-têtes de tableau, 3 formulaires Entrée/Transfert/Retrait) et
dans `JournalsPage.tsx` (colonne emplacement des mouvements de stock) —
visibles dans *toutes* les captures anglaises de ce chantier depuis le
début sans jamais avoir été repérés. Confirmé par lecture de
`StockService.ensureLocationsForStore` que seul `type`
("reserve"/"surface_vente", potentiellement suffixé par boutique) sert aux
comparaisons internes, jamais `name` — donc, comme pour les rôles, aucun
risque à ajouter une fonction d'affichage. Nouvelle fonction
`getLocationDisplayName(storedName)` dans `domain/stock.ts`, même principe
exact que `getRoleDisplayName` (table de correspondance inverse dérivée de
`DEFAULT_LOCATIONS`, résolution à l'appel, nom stocké inchangé). Anglais :
"Réserve" → "Reserve", "Surface de vente" → "Sales floor" (repris du texte
déjà traduit du panneau de transfert, "Reserve ↔ Sales floor transfer",
pour rester cohérent). **Vérifié dans le navigateur** : bascule EN sur
Stock → filtre, en-têtes de tableau et les 3 formulaires affichent bien
"Reserve"/"Sales floor" partout (au lieu du français brut vu jusqu'ici).

**Trou plus profond dans `SyscohadaService.ts`, découvert en creusant
`ROLE_LABELS`** : les libellés de compte SYSCOHADA (`ROLE_LABELS`, ex.
"État, TVA facturée sur ventes de marchandises") **alimentent directement
le champ `intitule` des lignes de journal exportées** (PDF/Excel) — un
objet statique figé au chargement du module (même piège que
`TIER_LABELS`/`DEFAULT_ROLES`), remplacé par une fonction (`t()` appelé à
la génération du compte, pas au chargement). En creusant plus loin,
**4 autres points de `SyscohadaService.ts`** construisaient aussi des
libellés de transaction ("Vente {{numéro}} — {{client}}", "Achat
{{numéro}} — {{fournisseur}}", "Règlement créance/dette — {{label}}",
"Remboursement vente {{numéro}}") et des noms de repli ("Client comptant",
"Client", "Fournisseur") entièrement en français en dur — convertis
(namespaces `syscohadaRoleLabels.*` et `syscohadaLabels.*`).
**Distinction volontaire faite avec `syscohadaExpenseAccounts.accountLabel`**
(seed SQL dans [client.ts](packages/database/src/client.ts), ex.
"Rémunérations directes versées au personnel") : **pas converti**, car
contrairement à `ROLE_LABELS` (fixe, aucune UI pour le modifier), ce champ
est une donnée de configuration comptable modifiable par l'utilisateur via
`upsertExpenseAccountMapping` (section Paramètres → Export SYSCOHADA →
tableau de correspondance charges) — même statut que `EXPENSE_CATEGORIES`
("Loyer", "Salaires"...), traité comme donnée métier, pas texte
d'interface, cohérent avec la convention déjà établie pour ce genre de
champ tout au long du chantier.

**Vérifié dans le navigateur, avec des données réelles** (pas juste le
typecheck) : export SYSCOHADA activé temporairement, Journal des ventes
généré sur la vente test VTE-2026-000001 — confirmé en anglais dans le
tableau ET dans le PDF exporté (intercepté via `URL.createObjectURL`) :
compte 571 libellé "Cash", compte 701 libellé "Merchandise sales", ligne
"Sale VTE-2026-000001 — Walk-in customer". Reproduit ensuite en français
(après re-génération du journal, la donnée déjà affichée ne se retraduit
pas rétroactivement à la simple bascule de langue — comportement attendu,
propre à toute donnée déjà résolue par un appel de service, pas un bug) :
"Caisse", "Ventes de marchandises", "Vente VTE-2026-000001 — Client
comptant" — identique au texte d'origine. Export SYSCOHADA redésactivé
après vérification pour laisser l'état de test comme trouvé.

**Vérifications supplémentaires effectuées** : rebuild forcé
(`turbo run build test --force`, cache ignoré) deux fois au cours de la
session pour écarter tout faux négatif de cache ; script de comparaison de
clés FR/EN (1291 clés de chaque côté, aucune différence) ; script de
validation que chaque `t("...")` littéral du code correspond à une clé
existante (0 manquante) ; re-balayage complet du dépôt après chaque lot de
correctifs pour confirmer la baisse du nombre de correspondances
restantes ; test du composant Imprimante (bouton "Printer" → panneau
traduit) ; test du sélecteur "Aucun résultat"/"No results" sur une
recherche produit sans correspondance.

**Restes identifiés, volontairement non touchés** (catégorisés, pas
oubliés) :
- `apps/web/src/app/DatabaseProvider.tsx` : `console.error` et l'erreur de
  mésusage de `useDatabase()` — jamais vus par un utilisateur.
- `packages/printer/src/logo.ts` : 2 messages d'erreur de rasterisation du
  logo — systématiquement avalés par un `try/catch` silencieux côté
  appelant (`receipt.ts`/`serviceTicket.ts`), jamais affichés ni journalisés.
- `packages/database/src/client.ts` (seed SQL `syscohada_expense_accounts`)
  et `syscohadaDefaultExpenseAccountLabel` : données de configuration
  comptable modifiables par l'utilisateur, traitées comme `EXPENSE_CATEGORIES`
  (donnée métier, pas texte d'interface).
- `packages/maintenance-cli` : outil CLI de maintenance/support technique,
  hors du périmètre "Interface + documents" du chantier (jamais vu par
  l'utilisateur final du commerce) — sortie console entièrement en français,
  décision assumée de ne pas le convertir.

**Résultat de cette re-vérification** : `pnpm run build` et les 20 tests
passent (rebuild forcé, cache ignoré) ; aucune erreur console à aucune
étape de la vérification navigateur ; le chantier bilinguisme est
maintenant réellement complet sur son périmètre déclaré, avec une
méthodologie de vérification (script de balayage + comparaison de clés)
plus fiable que la relecture manuelle qui avait laissé passer ces 9 trous.

### 2026-08-17 — Correctif : chevauchement de texte dans les tableaux PDF de `packages/reports`

**Contexte** : en relisant lui-même les PDF/Excel réellement générés
pendant la vérification du chantier bilinguisme (pas seulement le texte
brut extrait), le porteur du projet a repéré un vrai chevauchement visuel
dans le Journal des ventes SYSCOHADA exporté — "VTE-2026-000001" et "571"
(colonnes Pièce/Compte) fusionnés en un seul bloc de texte illisible, et la
description de transaction débordant sur les colonnes Débit/Crédit. Pas un
bug de traduction (le texte lui-même était correct dans les deux langues,
confirmé par les captures fournies) — un défaut de mise en page préexistant
dans `drawTable()` ([pdf.ts](packages/reports/src/pdf.ts)), révélé par ce
tableau à 7 colonnes de largeurs très inégales (codes courts vs libellés/
descriptions longs). Demande explicite d'étendre le correctif à
**"tous les fichiers générés"**, pas seulement ce tableau.

**Cause racine** : `drawTable()` divisait la page en colonnes de largeur
strictement égale et appelait `doc.text()` sans jamais retourner à la
ligne — contrairement à un navigateur, jsPDF ne retourne jamais
spontanément à la ligne un texte plus long que l'espace disponible, il
continue simplement hors de la zone prévue, d'où le chevauchement dès
qu'une colonne voisine commence avant que le texte précédent ne soit fini.
Risque présent dans **tout texte, indépendamment de la langue** — un
numéro de vente ("VTE-2026-000001") ou un intitulé de compte long
("État, TVA facturée sur ventes de marchandises") posent le même problème
en français qu'en anglais.

**Fait** :
- [pdf.ts](packages/reports/src/pdf.ts) : `drawTable()`/`drawTableRow()`
  réécrits pour retourner chaque cellule à la ligne dans la largeur de sa
  colonne (`doc.splitTextToSize()`), avec une hauteur de ligne dynamique
  par rangée (le nombre de lignes le plus élevé parmi les cellules de la
  rangée) — remplace l'ancienne hauteur fixe de 6mm qui supposait
  implicitement que rien ne débordait jamais. Nouveau paramètre optionnel
  `columnWeights` (répartition proportionnelle plutôt qu'égale) appliqué
  aux 3 tableaux qui ont vraiment besoin de colonnes de tailles très
  différentes : Journal SYSCOHADA (7 colonnes), Balance SYSCOHADA
  (5 colonnes), et la répartition produits (ABC) du rapport Marges
  (6 colonnes) — les autres tableaux (2 à 5 colonnes homogènes) gardent la
  répartition égale d'origine, désormais protégée par le même retour à la
  ligne en filet de sécurité si jamais un contenu inhabituel dépasse.
  Nouvelle fonction `drawWrappedSubtitle()` : les sous-titres interpolés
  (dates + plusieurs montants/compteurs) sont eux aussi retournés à la
  ligne si trop longs pour la largeur de page, avec le début du tableau
  décalé en conséquence pour ne jamais chevaucher une deuxième ligne de
  sous-titre — appliqué à `buildReportPdf` (utilisé par 7 des 9 rapports)
  et directement dans `buildMarginsReportPdf`/`buildCashFlowReportPdf` (les
  2 qui construisent leur sous-titre à la main, hors du chemin commun).
- [quotePdf.ts](packages/printer/src/quotePdf.ts) : même risque identifié
  par analogie (colonne "Article" en texte libre, sans retour à la ligne)
  — corrigé avec le même principe (`splitTextToSize` + hauteur de ligne
  dynamique par article).
- **Pas touché, déjà robuste** : [receiptPdf.ts](packages/printer/src/receiptPdf.ts)/
  [receipt.ts](packages/printer/src/receipt.ts)/[serviceTicket.ts](packages/printer/src/serviceTicket.ts)
  (reçu de vente, bon de dépôt) ont déjà leur propre mécanisme de retour à
  la ligne (`wrapText`/`pushWrapped`/`padLine`) depuis le correctif du
  2026-08-15 sur le texte coupé des tickets — confirmé sur les 2 vrais
  reçus fournis (FR et EN) qu'aucun chevauchement n'y existe.
  [labelsPdf.ts](packages/printer/src/labelsPdf.ts) utilise déjà l'option
  native `maxWidth` de jsPDF (retour à la ligne automatique). Les exports
  Excel ([excel.ts](packages/reports/src/excel.ts)) ne sont pas concernés
  par ce type de chevauchement (les cellules d'un tableur ne se
  superposent jamais visuellement — au pire une colonne trop étroite
  tronque l'affichage jusqu'à ce que l'utilisateur l'élargisse, un
  comportement standard de tableur, pas un bug applicatif).

**Vérifié dans le navigateur, avec les données réelles fournies par le
porteur du projet** (vente VTE-2026-000001) : export SYSCOHADA réactivé
temporairement, Journal des ventes régénéré en PDF, blob intercepté et
décodé en fichier local pour relecture visuelle directe (pas seulement le
texte brut) — confirmé : plus aucun chevauchement, "VTE-2026-000001" et
"571" bien séparés sur des colonnes distinctes, description de transaction
proprement retournée à la ligne dans sa propre colonne sans déborder sur
Débit/Crédit. Un premier passage avait encore un léger défaut cosmétique
(l'en-tête "Compte" coupé en "Compt"/"e" sur deux lignes, faute d'une
colonne large de quelques mm) — poids de colonnes réajustés
(`[1.3, 1.6, 1.0, 2.3, 2.6, 1.0, 1.0]`) et revérifié : "Compte" tient
maintenant sur une seule ligne, tout le reste du tableau reste correct.
Rapport des ventes (2-3 colonnes homogènes, déjà correct avant ce
correctif) revérifié aussi pour confirmer l'absence de régression après le
changement de `buildReportPdf`. `pnpm run build` (rebuild forcé, cache
ignoré) et les 20 tests unitaires passent. Aucune erreur console.

**Pas fait / laissé de côté** :
- Alignement à droite des colonnes numériques (Débit/Crédit/Montant) — pas
  demandé, purement cosmétique, risque de régression visuelle non justifié
  pour ce correctif ciblé sur le chevauchement/troncature.
- Vérification visuelle exhaustive de chaque combinaison rapport × langue
  (18 rapports PDF possibles) — le mécanisme de retour à la ligne est
  générique et déjà vérifié sur le cas le plus complexe (7 colonnes,
  contenu le plus long) ; risque jugé faible sur les tableaux plus simples
  déjà couverts par le même filet de sécurité.

### 2026-08-17 — Audit et correctifs responsive (mobile/tablette)

**Contexte** : retour explicite du porteur du projet — "l'application n'est
pas assez responsive, sur les petits écrans surtout mobile, la manipulation
n'est pas assez facile". Aucune media query n'existait nulle part dans
l'app avant cette session (confirmé par recherche sur tout `apps/web/src`)
— l'app n'avait jamais été vérifiée à une largeur inférieure au bureau.
Vérification faite en conditions réelles (navigateur redimensionné à
375px, 768px, 1280px), pas seulement en lisant le code : un script
JS (`window.__checkOverflow()`, injecté dans la page) mesure
`document.documentElement.scrollWidth` vs `window.innerWidth` après
chaque navigation pour détecter tout débordement horizontal forçant la
page entière à défiler sur le côté — bien plus fiable qu'une inspection
visuelle, en particulier dans cet environnement où `computer`/`screenshot`
échouent régulièrement (pane non composité, déjà documenté dans ce
fichier).

**3 causes racines systémiques trouvées**, chacune répétée dans un grand
nombre de fichiers (pas des bugs isolés — un même défaut de layout copié-
collé partout dans l'app depuis le début) :

1. **Aucune ligne à largeur fixe ne repassait à la ligne** (`flexWrap`
   manquant). Motif `display: "flex", justifyContent: "space-between"`
   (titre de page + bouton(s) d'action) trouvé sans `flexWrap` dans **26
   occurrences sur ~20 fichiers** — confirmé en direct que ça casse la page
   dès que le titre + les boutons ne tiennent pas sur une seule ligne à
   375px (ex: la barre du haut, `TopBar.tsx`, poussait toute la page à
   502px de large sur un écran de 375px). Un second motif, moins visible au
   premier passage — le groupe de boutons *à l'intérieur* de cette même
   ligne (`display: "flex", gap: 8`, sans son propre `flexWrap`) — repéré
   après coup en testant réellement la page Ventes en mobile (le groupe
   "Mode Caisse/Mode Formulaire/Imprimante/Fermer la caisse" débordait tout
   seul une fois le premier niveau corrigé) : **16 occurrences
   supplémentaires**, plus quelques variantes avec un `gap` différent
   (6 occurrences). Corrigé partout par l'ajout de `flexWrap: "wrap"`
   (+ `gap` si absent) — un no-op sur grand écran (le contenu tient déjà
   sur une ligne), donc aucun risque de régression visuelle desktop.
2. **Aucun tableau ne pouvait défiler dans sa propre largeur** — tous les
   `<table style={tableStyle}>` (19 fichiers, 30 tableaux au total, y
   compris un cas de tableau imbriqué dans `ServiceOrdersPage.tsx`) étaient
   rendus à leur largeur de contenu réelle, sans conteneur
   `overflow-x: auto` — un tableau à 6-7 colonnes force alors toute la page
   (en-tête sticky compris) à défiler horizontalement sur mobile. Chaque
   `<table>` est maintenant enveloppé dans `<div style={{ overflowX:
   "auto" }}>` — le tableau défile dans sa propre boîte, le reste de la
   page (nav, en-tête) reste fixe. Approche par enveloppe DOM plutôt que le
   classique `table { display: block; overflow-x: auto }` en CSS global :
   ce dernier casse l'alignement des colonnes entre `<thead>` et `<tbody>`
   (deux contextes de mise en page de tableau séparés, chacun dimensionne
   ses colonnes indépendamment) — pas acceptable pour des tableaux de
   données.
3. **Grilles à colonne fixe qui ne s'empilent jamais** —
   `gridTemplateColumns: "1fr 380px"` (liste de produits/articles + panier)
   codé en dur dans **4 pages structurellement identiques** (Ventes, Achats,
   Devis, Tickets de service) : sur un écran de 375px, la seule colonne
   fixe de 380px dépasse déjà la largeur de l'écran à elle seule — la page
   la plus utilisée d'un POS (Ventes) était donc essentiellement inutilisable
   en mobile. Une media query ne peut pas s'exprimer dans un objet
   `CSSProperties` (contrainte du style inline utilisé partout dans cette
   app) — nouvelle classe partagée `.cart-layout-grid`
   ([index.css](apps/web/src/app/index.css)) : `1fr 380px` au-dessus de
   720px (identique à l'ancien rendu desktop, vérifié pixel pour pixel :
   508px/380px sur 1280px de large), colonne unique en dessous. Les 4 pages
   utilisent maintenant `className="cart-layout-grid"` au lieu de leur
   style inline dupliqué.

**Autres correctifs, plus ciblés** :
- [Nav.tsx](apps/web/src/app/Nav.tsx) : les 19 onglets passent de
  `flexWrap: "wrap"` (jusqu'à 5-6 lignes de boutons empilées, énorme perte
  d'espace vertical sur mobile) à une **bande défilante horizontalement en
  une seule ligne** (`overflowX: "auto"`, motif d'onglets mobile standard)
  — vérifié que la nav défile dans sa propre boîte (1740px de contenu dans
  375px) sans jamais faire déborder la page.
- [sharedStyles.ts](apps/web/src/components/sharedStyles.ts) :
  `pageStyle.padding` passe de `24` fixe à `clamp(12px, 4vw, 24px)` — moins
  de marge perdue sur petit écran, identique à 24px au-delà d'environ
  600px de large, sans avoir besoin de media query (fonction CSS pure).
- 3 modales ([ChangePasswordModal.tsx](apps/web/src/features/auth/ChangePasswordModal.tsx),
  [RefundModal.tsx](apps/web/src/features/journals/RefundModal.tsx),
  [RefundHistoryModal.tsx](apps/web/src/features/journals/RefundHistoryModal.tsx)) :
  largeur fixe (380px/560px) remplacée par `width: "min(380px, 100%)"` (ou
  560px) + `padding: 16` sur l'overlay — la modale se réduit pour tenir
  dans un écran plus étroit que sa largeur "normale" au lieu de déborder ;
  `maxHeight: "85vh", overflowY: "auto"` ajouté à `ChangePasswordModal`
  (déjà présent sur les deux autres) pour qu'un clavier virtuel mobile ne
  pousse jamais le bas du formulaire hors d'atteinte.

**Vérifié dans le navigateur, à 3 largeurs** (375px mobile, 768px tablette,
1280px desktop), avec des comptes/données réels (pas des pages vides) :
**les 20 onglets de navigation un par un** (Accueil, Ventes, Historique des
ventes, Devis, Produits, Stock, Clients, Fournisseurs, Achats, Créances,
Dettes, Rapports — les 4 sous-onglets, Dépenses, Comptabilité — Bilan
compris, Paramètres, Utilisateurs, Journaux, Tickets de service — les 3
vues, Promotions), plus l'écran de connexion, l'écran de verrouillage PIN,
une modale (Rembourser, ouverte depuis Journaux), et un formulaire
("Nouveau produit") — **zéro débordement horizontal de page restant** sur
toute cette liste. Confirmé qu'à 1280px la grille Ventes/panier rend
exactement comme avant (508px/380px, aucun changement visuel desktop).
`pnpm run build` (rebuild forcé, cache ignoré) et les 20 tests unitaires
passent. Aucune erreur console (hors WebSocket HMR habituel).

**Pas fait / laissé de côté** :
- Pas de refonte de la nav en menu hamburger/tiroir — la bande défilante
  horizontale est un correctif net et à faible risque (une seule classe
  CSS, pas de nouvel état React, pas de changement de comportement au
  clic) ; un vrai menu tiroir serait une refonte plus lourde, pas demandée
  explicitement et hors du périmètre "s'assurer que l'app s'adapte à tous
  les écrans" de cette session.
- Pas de revue de la taille des cibles tactiles (zones de clic bouton/lien
  trop petites au doigt) au-delà de ce qui découle déjà des correctifs
  ci-dessus — un audit distinct, non demandé cette fois.
- Le clavier numérique de `PinLockScreen` (chiffres 1-9/0/⌫) n'a pas été
  spécifiquement testé au tactile (grille de boutons déjà en `display:
  grid`, taille de bouton déjà généreuse) — risque jugé faible.
- `BarcodeCameraScanner` (plein écran, déjà à `maxWidth: 480, width:
  "100%"`) non retouché — déjà responsive avant cette session.

### 2026-08-17 — Responsive : re-vérification avec captures réelles, 3 bugs supplémentaires trouvés et corrigés

**Contexte** : le porteur du projet a testé lui-même sur un vrai téléphone
après le correctif responsive précédent et fourni 3 captures d'écran réelles
(Accueil, Produits, Clients) — retour : "j'ai l'impression que tu n'as pas
analysé toutes les fenêtres [...] je n'ai même pas testé toute l'appli".
Deux défauts visibles sur les captures : les colonnes de droite des tableaux
(ÉTIQUETTES, boutons Modifier/Ajuster points) restaient coupées sans aucun
indice qu'il fallait défiler horizontalement, et un grand espace vide sous
le tableau sur Produits/Clients.

**Diagnostic de l'espace vide** : **pas un bug** — vérifié par inspection
directe (`main` mesurait 427px de haut sur un viewport de 812px) : avec un
seul produit/client en base de test, le tableau est simplement court sur un
écran de téléphone haut. Avec un vrai catalogue de 20-50 produits, cet
espace se remplit naturellement. Rien à corriger ici.

**Correctif réel — indice de scroll horizontal invisible** : le
`overflow-x: auto` posé sur chaque tableau (session précédente) fonctionnait
mais n'était signalé que par la scrollbar `::-webkit-scrollbar` globale
(10px, couleur `var(--color-border)`) — visible mais discrète, facilement
manquée sur un vrai écran tactile où rien n'indique qu'il reste du contenu
caché tant qu'on n'a pas déjà commencé à toucher l'écran. Nouvelle classe
`.table-scroll` dans [index.css](apps/web/src/app/index.css) : technique CSS
pure "scroll shadows" (dégradés `background-attachment: local`/`scroll`
superposés, sans JS) — une ombre de bord apparaît uniquement du côté où il
reste du contenu caché, disparaît automatiquement une fois arrivé au bout.
Les **30 wrappers `<div style={{ overflowX: "auto" }}>`** posés la session
précédente (19 fichiers) remplacés par `className="table-scroll"`.

**3 vrais bugs de débordement trouvés pendant le balayage** — la méthode de
vérification précédente (`scrollWidth > window.innerWidth`) s'est révélée
elle-même défaillante : l'émulation mobile élargit le viewport layout pour
englober le contenu qui déborde, donc `scrollWidth` ET `innerWidth`
grandissent ensemble après coup, rendant la comparaison aveugle. Corrigé en
comparant contre une référence fixe (375px, la largeur réellement demandée)
plutôt que contre `window.innerWidth`. Avec cette méthode plus fiable,
balayage de **tous les onglets + sous-onglets + modales** (pas seulement
quelques pages comme la session précédente) :
1. **Rapports → onglet "Tickets de service"** : son tableau n'avait jamais
   eu de wrapper `overflow-x` du tout (contrairement aux tables voisines du
   même fichier) — raté par le "sweep" de la session précédente car ce
   n'était pas un simple oubli de wrapper mais une table jamais wrappée dès
   l'origine. Corrigé.
2. **Rapports → 3 rangées de cartes KPI** (onglets Ventes/Marges/TVA) :
   `display: "flex", gap: 16` sans `flexWrap` — TVA a 4 cartes, déborde le
   premier à 375px (les rangées à 3 cartes de Ventes/Marges passaient de
   justesse, mais couraient le même risque). Les 3 corrigées avec
   `flexWrap: "wrap"`, même motif que le reste de l'app.
3. **Comptabilité → onglet SYSCOHADA (Journal ventes/achats/trésorerie ET
   Balance générale)** : les 2 tableaux n'avaient eux non plus jamais eu de
   wrapper — chacun un tableau à 5-7 colonnes, le pire cas possible sur
   mobile. Corrigés (`className="table-scroll"`).
4. Repéré en passant, même motif manquant : le tableau de mapping de charges
   SYSCOHADA dans
   [SyscohadaAccountsSection.tsx](apps/web/src/features/settings/SyscohadaAccountsSection.tsx)
   (jamais wrappé), et les rangées de boutons de 3 modales
   (`ChangePasswordModal`, `RefundModal`, `RefundHistoryModal`) sans
   `flexWrap` — corrigés par précaution (risque faible vu la largeur des
   modales déjà contrainte, mais coût nul).

**Vérifié dans le navigateur, à 375px, avec des données réelles créées pour
l'occasion** (pas des pages vides) : compte Admin, produit "Samsung Galaxy
A14 128Go Noir" (nom volontairement long, pour reproduire le cas de la
capture fournie), client réel — balayage systématique des 18 onglets
principaux + tous les sous-onglets accessibles (Journaux ×3, Rapports ×6 y
compris TVA et Tickets de service, Comptabilité ×3 y compris les 4 vues
SYSCOHADA, Tickets de service ×3) + module Promotions + panier Ventes avec
un article ajouté + PrinterPanel + ouverture de caisse + tentative
d'encaissement, chaque fois avec le script `scrollWidth vs 375px fixe` :
**zéro débordement restant** après les 3 correctifs ci-dessus (contre 3
trouvés avant correction). `pnpm run build` et les 20 tests unitaires
passent. Modules de test (TVA/Promotions/multi-boutique/SYSCOHADA) réactivés
temporairement pour atteindre ces pages, puis désactivés à nouveau après
vérification pour laisser l'état de test comme trouvé.

**Leçon retenue pour toute future vérification responsive** : ne jamais
comparer `scrollWidth` à `window.innerWidth` sur mobile (les deux peuvent
dériver ensemble) — comparer à la largeur de viewport réellement demandée en
constante fixe. Et un "sweep" par simple recherche de motif texte
(`style={{ overflowX: "auto" }}`, `flexWrap`) ne trouve que ce qui a déjà été
*commencé* à corriger — une table qui n'a jamais eu de wrapper à l'origine
(comme les 2 cas SYSCOHADA et le cas Tickets de service ci-dessus) est
invisible à ce genre de recherche ; seul un parcours réel de chaque page/
sous-page dans le navigateur les révèle.

### 2026-08-17 — Responsive : fermeture des derniers trous (surfaces non rouvertes + tablette)

**Contexte** : à la question explicite "est-ce que le responsive est vraiment
effectif partout ?", plutôt que de réaffirmer une confiance non regagnée
après le correctif précédent, liste honnête de ce qui restait non revérifié
(3 modales éditées sans être rouvertes, StoresSection, Devis/Créances/Dettes
avec données réelles, formulaires Stock/Produits/Utilisateurs/Dépenses/
Promotions, écran PIN, et le point de rupture tablette 768px jamais testé du
tout) — puis fermeture effective de chacun.

**4 vrais bugs supplémentaires trouvés**, tous variantes du même motif déjà
documenté (ligne `display:"flex"` avec plusieurs enfants interactifs, sans
`flexWrap`) mais qui avaient échappé aux recherches précédentes car soit
imbriqués dans un conteneur qui, lui, avait bien `flexWrap` (le `flexWrap`
du parent ne protège pas ses propres enfants directs), soit sur un objet de
style étalé sur plusieurs lignes (invisible à une recherche mono-ligne) :
1. [DebtsPage.tsx](apps/web/src/features/debts/DebtsPage.tsx) — ligne
   montant + boutons Confirmer/Annuler du paiement de dette (avait
   `flexWrap` côté Créances mais pas côté Dettes, incohérence entre les deux
   pages jumelles).
2. [CreditsPage.tsx](apps/web/src/features/credits/CreditsPage.tsx) — même
   ligne montant + boutons, mais imbriquée dans un conteneur externe qui
   avait déjà `flexWrap` alors que la ligne elle-même (le vrai contenu à
   largeur variable) ne l'avait pas.
3. [ServiceOrdersPage.tsx](apps/web/src/features/serviceOrders/ServiceOrdersPage.tsx) —
   ligne "Solde restant : X" + champ + bouton du remboursement de créance
   liée à un ticket de service (style étalé sur plusieurs lignes).
4. [CustomersPage.tsx](apps/web/src/features/customers/CustomersPage.tsx) —
   ligne d'ajustement de points fidélité (2 champs + 2 boutons).

Trouvés par une recherche `Grep` élargie (avec `multiline: true` pour
couvrir les styles étalés sur plusieurs lignes) plutôt que par balayage
navigateur cette fois — plus rapide et plus exhaustif pour ce motif précis
une fois qu'on sait exactement quoi chercher.

**Vérifié dans le navigateur**, à 375px ET 768px cette fois (le point de
rupture tablette n'avait jamais été testé avant cette session) : les 19
onglets principaux + tous les sous-onglets (Journaux, Rapports y compris
TVA/Tickets de service, Comptabilité y compris les 4 vues SYSCOHADA, Tickets
de service) balayés aux deux largeurs, écran de connexion, écran PIN
verrouillé, StoresSection + mapping SYSCOHADA (modules réactivés
temporairement), formulaires d'édition Produits/Utilisateurs, formulaire
Dépenses, formulaire Promotions, Devis avec un article réellement ajouté au
panier, page Stock avec les 3 formulaires (Entrée/Transfert/Retrait) et une
vraie tentative de saisie, ligne "Ajuster points" de Clients réellement
ouverte (confirmée sans débordement après le correctif #4 ci-dessus). Grille
Ventes/panier confirmée en mode 2 colonnes correct à 768px
(`306.4px 380px`, juste au-dessus du seuil de 720px). `pnpm run build` et
les 20 tests unitaires passent (deux fois, après chaque lot de correctifs).
Modules de test désactivés à nouveau après vérification.

**Pas vérifié** : le flux complet de remboursement de créance/dette avec de
vraies données (bloqué par un souci de stock à 0 sur le produit de test,
sans rapport avec le responsive) — le correctif de code est identique à un
motif déjà vérifié des dizaines de fois ailleurs dans l'app
(`flexWrap: "wrap"` sur une ligne input+boutons), risque jugé nul.

## Prochaines pistes suggérées

1. Décider d'installer ESLint ou de retirer le script `lint` du
   `package.json` pour ne pas induire en erreur.
2. Un harnais de test d'intégration (SQLite en mémoire compatible avec le
   type `Database` du proxy) permettrait de couvrir automatiquement les flux
   multi-étapes (transferStock, createSale→marge, sessions de caisse) plutôt
   que par vérification manuelle dans le navigateur à chaque session.
3. Si le besoin apparaît : distinguer les opérateurs mobile money (décision
   explicite de ne pas le faire pour l'instant, prise à la session précédente).
4. **FNE Côte d'Ivoire** (voir journal 2026-08-13 ci-dessus) — obligation
   légale, pas une feature optionnelle, si une part des utilisateurs est en
   Côte d'Ivoire. Bloqué tant qu'aucun compte DGI/clé API n'est disponible
   pour développer contre la vraie spec.
5. ~~Bilinguisme FR/EN~~ — **chantier intégralement terminé** le 2026-08-17
   sur son périmètre initial ("Interface + documents", lancé le
   2026-08-15) : toutes les pages de l'app, tout l'écran de connexion, les
   62 messages d'erreur de `packages/core` (`coreErrors.*`),
   `TIER_LABELS`→`getTierLabel`, `SimpleChart.tsx`, les 5 messages WhatsApp
   générés côté client (`whatsapp.*`), le contenu des documents
   `packages/printer`/`packages/reports` (`documents.*`), et enfin
   `DEFAULT_ROLES` (via `getRoleDisplayName`, mapping d'affichage sans
   toucher au nom stocké en base) — voir le journal et la section
   *Internationalisation* ci-dessus pour le détail complet. Plus aucune
   piste ouverte sur ce chantier.
6. ~~À investiguer : activer "Appliquer la TVA"/"Tickets de service" ne
   persistait pas~~ — **résolu, ce n'était pas un bug applicatif.** Cause
   trouvée en session suivante (2026-08-16, conversion de
   `ServiceOrdersPage.tsx`) : `document.querySelectorAll('button')` avec un
   filtre sur le texte exact "Save" attrapait le *premier* bouton "Save" du
   DOM, qui est un bouton "Enregistrer" par ligne du tableau de mapping
   SYSCOHADA (`SyscohadaAccountsSection.tsx`, un par catégorie de dépense),
   pas le bouton principal de sauvegarde des Paramètres tout en bas de la
   page — les deux partagent le même texte. Une fois ce bouton précis ciblé
   (`.filter(...)[length-1]`, le dernier plutôt que le premier), la
   sauvegarde a fonctionné du premier coup et les deux cases sont restées
   cochées après rechargement. Un piège de script de vérification, pas de
   l'application — à garder en tête pour les prochaines vérifications
   navigateur : toute page avec plusieurs boutons au texte identique
   ("Save"/"Enregistrer"/"Delete"/"Supprimer"...) doit être ciblée par un
   sélecteur plus précis qu'un simple filtre sur le texte.
