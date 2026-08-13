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

## Prochaines pistes suggérées

1. Décider d'installer ESLint ou de retirer le script `lint` du
   `package.json` pour ne pas induire en erreur.
2. Un harnais de test d'intégration (SQLite en mémoire compatible avec le
   type `Database` du proxy) permettrait de couvrir automatiquement les flux
   multi-étapes (transferStock, createSale→marge, sessions de caisse) plutôt
   que par vérification manuelle dans le navigateur à chaque session.
3. Si le besoin apparaît : distinguer les opérateurs mobile money (décision
   explicite de ne pas le faire pour l'instant, prise à la session précédente).
4. Ajouter `update_product` (et vérifier les autres actions loguées) à
   `ACTION_LABELS` dans JournalsPage.tsx pour un affichage francisé complet.
