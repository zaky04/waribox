# WariBox — notes de suivi du projet

Application de gestion de commerce (POS) **offline-first** pour petits commerces.
Ce fichier est le point d'entrée pour tout dev ou toute IA qui reprend le projet :
il documente l'architecture réelle (vérifiée, pas supposée) et les conventions
métier importantes ; le journal daté des décisions/travaux (pour garder le fil
d'une session à l'autre) est dans [docs/JOURNAL.md](docs/JOURNAL.md). À tenir à jour à chaque changement structurant —
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
packages/core        → toute la logique métier, 1 fichier services/*Service.ts par domaine ;
                       sync/ = mode réseau (protocole du Maître, suivi par l'appareil relié, instantané) ;
                       auth/ = mots de passe, PIN, preuves de PIN à distance ; backup/ = chiffrement
packages/i18n        → instance i18next partagée (FR/EN), devises, pays
packages/network     → messages WebSocket et contenu du QR de pairage (sans dépendance)
packages/printer      → tickets ESC/POS, étiquettes PDF
packages/reports      → export PDF et Excel (écrivain .xlsx maison, sans dépendance)
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

- **Contrôles obligatoires dans la transaction** : `withTransaction` n'est PAS réentrante (verrou en file :
  une transaction imbriquée se bloque). Tout contrôle d'état (statut, solde, « déjà fait ») se relit **à
  l'intérieur** de la transaction qui écrit ; une vérification de PIN reste **hors** transaction (un échec doit
  laisser son compteur d'essais). Ne jamais appeler une fonction qui ouvre sa propre transaction depuis
  l'intérieur d'une autre.
- **Jours locaux, horodatages UTC** : `created_at` & co. sont en UTC ; « aujourd'hui » et les périodes de
  rapport sont des jours LOCAUX. Toute borne de période passe par `localDayStartUtc/EndUtc`, tout
  regroupement par jour par `utcToLocalDay` ([localDay.ts](packages/core/src/domain/localDay.ts)), tout
  affichage par `formatDateTime` ([dateTime.ts](apps/web/src/lib/dateTime.ts)).
- **Appareil relié = lecture seule sur le catalogue** : toute fonction qui écrit des données de catalogue (ou une
  opération non répliquée) commence par `assertMasterOnly(...)` ([relayGuard.ts](packages/core/src/domain/relayGuard.ts)).
  Toute nouvelle table « du Maître » doit être ajoutée à l'instantané ([snapshot.ts](packages/core/src/sync/snapshot.ts)) ;
  toute nouvelle opération qui touche au stock doit être répliquée (événement) OU gardée par `assertMasterOnly`,
  sinon l'alignement du stock l'annulerait.
- **Réécrire une lecture pour la rendre plus rapide ?** Prendre d'abord un instantané de sa sortie avec
  l'ANCIEN code sur un jeu de données varié, puis comparer (voir `MarginsReports.test.ts`,
  `ControlsReport.test.ts`, `TaxAndDailyReads.test.ts`), et vérifier par mutation que le test échoue si on casse un filtre.

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
- **Périmètre couvert** : toutes les pages, l'écran de connexion, les messages d'erreur des services
  (`coreErrors.*`, `syncChecks.*`), les messages WhatsApp (`whatsapp.*`), le contenu des documents imprimés et
  exportés (`documents.*`), les noms de rôles et d'emplacements par défaut. **Pièges récurrents** : un objet ou
  un tableau d'options qui appelle `t()` doit vivre DANS le composant ou être une fonction (sinon il ne suit pas un
  changement de langue) ; les données saisies par l'utilisateur ou seedées en base (noms de rôles, d'emplacements,
  catégories de dépense, comptes SYSCOHADA modifiables) ne se traduisent pas dans le stockage — seul leur
  affichage passe par une table de correspondance (`getRoleDisplayName`, `getLocationDisplayName`).
  Un test vérifie que FR et EN ont exactement les mêmes clés et que chaque `t("…")` littéral existe.
  Détail historique du chantier : [docs/JOURNAL.md](docs/JOURNAL.md) (entrées des 2026-08-15 à 2026-08-17).

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
- `pnpm lint` (web) = vérification de types (`tsc --noEmit`) : il n'y a pas d'ESLint.
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

## État actuel et ce qu'il faut savoir avant de reprendre

- **Vérification de référence** : `pnpm exec turbo run build test` (compile tout le monorepo, ~350 tests dont
  les parcours métier sur une vraie base SQLite en mémoire — voir `packages/core/src/test/`), et
  `cargo test --lib` dans `apps/desktop/src-tauri` pour le serveur réseau Rust. Une CI GitHub
  ([.github/workflows/ci.yml](.github/workflows/ci.yml)) lance le premier à chaque push/pull request, plus
  `pnpm audit --prod`. Node ≥ 22.13 requis (les tests utilisent `node:sqlite`).
- **Tout le contrôle d'accès est côté client** (droits, seuils d'approbation, PIN) : il protège contre
  l'erreur et l'employé qui utilise l'interface, pas contre quelqu'un qui ouvre la console du navigateur
  ou lit le disque. La base n'est pas chiffrée sur l'appareil ; les sauvegardes peuvent l'être (mot de passe).
- **Mode réseau Maître / Appareil relié** : le Maître fait foi pour le catalogue et le stock ; l'appareil
  relié les reçoit (empreintes, alignement du stock) et ne les modifie pas. Seuls ventes, dépenses,
  mouvements de stock et demandes d'approbation sont répliqués ; le reste est bloqué ou reste local sur
  l'appareil relié (bandeau). Se relier REMPLACE les données de l'appareil (`resetBusinessData`, copie de
  sécurité d'abord) ; la progression de synchro est liée à l'identité du Maître (`getHelloSeq`).
  Jamais testé sur deux appareils physiques. Voir `packages/core/src/sync/` et
  les entrées du 2026-09-04 à 2026-10-31 du journal.
- **Android** : `pnpm android:sync` après tout `tauri android init` (réapplique `MainActivity.kt` et le
  trafic non chiffré vers le Maître) ; `gen/` est ignoré par git.
- **Limites connues, assumées** : le journal SYSCOHADA et quelques rapports relisent encore des tables entières
  (lents au-delà de quelques dizaines de milliers de lignes) ; les règlements de dettes fournisseurs n'ont pas
  de mode de paiement et ne comptent pas dans le tiroir (achats et dépenses en espèces, eux, comptent) ; pas d'avoir FNE sur remboursement ; achats,
  remboursements, règlements, caisse, tickets de service et inventaires ne sont pas répliqués entre appareils.
- **Journal détaillé de chaque chantier** (décisions, preuves, pièges, ce qui n'a pas été fait) :
  [docs/JOURNAL.md](docs/JOURNAL.md) — à lire avant de toucher au réseau, aux approbations ou aux rapports.
