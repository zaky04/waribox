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
  en plusieurs étapes doit être enveloppée dedans** (voir `createSale` et
  `createRefund` pour le modèle à suivre). Ne pas oublier d'envelopper toute la
  séquence, pas seulement les écritures — sinon la validation peut être
  contournée par une opération concurrente.

## Base de données / migrations

Pas de vrai runner de migrations. Le schéma vit dans
[packages/database/src/schema/*.ts](packages/database/src/schema) et un
**bootstrap SQL idempotent**
([bootstrap-sql.ts](packages/database/src/bootstrap-sql.ts) +
`MIGRATION_SQL` dans [client.ts](packages/database/src/client.ts)) tourne au
démarrage : `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` (erreur
avalée si la colonne existe déjà). C'est assumé comme provisoire par les
commentaires du code ("Phase 0" → un vrai runner Drizzle Kit viendrait en
"Phase 1"). **Toute nouvelle colonne doit être ajoutée à `MIGRATION_SQL`**, pas
seulement au schéma Drizzle, sinon les bases déjà installées ne la reçoivent
jamais.

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

- **Marge non historisée** : `getMarginsSummary`
  ([ReportsService.ts:121](packages/core/src/services/ReportsService.ts:121))
  utilise `products.purchasePrice` *actuel*, pas le coût réel du lot vendu —
  imprécis si le prix d'achat a changé depuis la vente. Commenté dans le code
  comme "Phase 7" à faire.
- **Pas de suivi de coût par lot d'achat** pour le calcul de marge — même
  cause que ci-dessus.
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

## Prochaines pistes suggérées

1. Étendre la même protection transactionnelle à `PurchasesService` (achats) —
   même schéma de risque que ventes/remboursements.
2. Décider d'installer ESLint ou de retirer le script `lint` du
   `package.json` pour ne pas induire en erreur.
3. Formaliser un vrai runner de migrations (Drizzle Kit) plutôt que le
   bootstrap SQL brut, avant que le nombre de colonnes en `ALTER TABLE` ne
   devienne difficile à suivre.
4. Historiser le coût d'achat par lot pour fiabiliser le calcul de marge
   (`ReportsService.getMarginsSummary`).
