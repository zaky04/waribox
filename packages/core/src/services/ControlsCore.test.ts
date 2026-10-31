import { describe, expect, it } from "vitest";
import { computeAuditHash, verifyAuditRows, type AuditChainRow } from "./AuditService";
import { exceedsThreshold, pickThreshold } from "./ApprovalService";

async function buildChain(n: number): Promise<AuditChainRow[]> {
  const rows: AuditChainRow[] = [];
  let prev = "GENESIS";
  for (let i = 1; i <= n; i++) {
    const f = { userId: 1, action: `a${i}`, entity: "x", entityId: i, metadata: `{"i":${i}}`, createdAt: `2026-09-25 10:00:0${i}` };
    const hash = await computeAuditHash(prev, f);
    rows.push({ id: i, prevHash: prev, hash, ...f });
    prev = hash;
  }
  return rows;
}

describe("chaîne d'intégrité du journal", () => {
  it("accepte une chaîne intacte et donne le hash de tête", async () => {
    const rows = await buildChain(5);
    const r = await verifyAuditRows(rows);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(5);
    expect(r.headHash).toBe(rows[4]!.hash);
  });

  it("détecte une ligne modifiée", async () => {
    const rows = await buildChain(4);
    rows[2] = { ...rows[2]!, metadata: '{"i":999}' };
    const r = await verifyAuditRows(rows);
    expect(r.ok).toBe(false);
    expect(r.brokenAtId).toBe(3);
    expect(r.reason).toBe("hash_mismatch");
  });

  it("détecte une ligne supprimée au milieu", async () => {
    const rows = await buildChain(5);
    rows.splice(2, 1);
    const r = await verifyAuditRows(rows);
    expect(r.ok).toBe(false);
    expect(r.brokenAtId).toBe(4);
    expect(r.reason).toBe("prev_mismatch");
  });

  it("détecte une ligne insérée sans hash après le début de la chaîne", async () => {
    const rows = await buildChain(3);
    rows.push({ id: 4, prevHash: null, hash: null, userId: 1, action: "fake", entity: "x", entityId: null, metadata: null, createdAt: "2026-09-25 11:00:00" });
    const r = await verifyAuditRows(rows);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unhashed_after_chain");
  });

  it("ignore les lignes antérieures à la fonctionnalité (sans hash)", async () => {
    const legacy: AuditChainRow = { id: 1, prevHash: null, hash: null, userId: 1, action: "old", entity: "x", entityId: null, metadata: null, createdAt: "2026-01-01 00:00:00" };
    const chain = (await buildChain(2)).map((r) => ({ ...r, id: r.id + 1 }));
    const r = await verifyAuditRows([legacy, ...chain]);
    expect(r.ok).toBe(true);
    expect(r.legacyRows).toBe(1);
    expect(r.checked).toBe(2);
  });

  it("une base vide est valide", async () => {
    expect((await verifyAuditRows([])).ok).toBe(true);
  });
});

describe("seuils d'approbation", () => {
  it("le plafond personnel prime sur le seuil global", () => {
    expect(pickThreshold(5000, 20000)).toBe(5000);
    expect(pickThreshold(null, 20000)).toBe(20000);
    expect(pickThreshold(undefined, null)).toBeNull();
    expect(pickThreshold(0, 20000)).toBe(0);
  });

  it("dépassement strict ; null = aucun contrôle ; 0 = tout est contrôlé", () => {
    expect(exceedsThreshold(20000, 20000)).toBe(false);
    expect(exceedsThreshold(20001, 20000)).toBe(true);
    expect(exceedsThreshold(1_000_000, null)).toBe(false);
    expect(exceedsThreshold(1, 0)).toBe(true);
  });
});
