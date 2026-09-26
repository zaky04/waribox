import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// File des demandes d'approbation. Deux usages selon le mode choisi par le
// propriétaire pour chaque domaine (business_settings.approval_mode_*) :
//  - « à valider ensuite » (stock : entrées, pertes, achats, inventaire) : l'effet
//    est déjà appliqué, la demande sert à le faire valider — un refus crée un
//    mouvement inverse (le grand livre ne s'efface jamais) ;
//  - « bloquée jusqu'à validation » (dépenses, points) : rien n'est appliqué tant
//    que la demande n'est pas approuvée ; payload = de quoi rejouer l'action.
// sync_id : prêt pour la validation à distance depuis un autre appareil (mode réseau).
export const approvalRequests = sqliteTable("approval_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  syncId: text("sync_id"),
  kind: text("kind").notNull(), // 'stock' | 'expense' | 'points'
  status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
  amount: real("amount").notNull().default(0),
  requestedBy: integer("requested_by"),
  storeId: integer("store_id"),
  summary: text("summary").notNull(),
  payload: text("payload"),
  decidedBy: integer("decided_by"),
  decidedAt: text("decided_at"),
  decisionNote: text("decision_note"),
  // Faux tant que le demandeur n'a pas vu la décision (1 par défaut : les anciennes lignes).
  decisionSeen: integer("decision_seen", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
