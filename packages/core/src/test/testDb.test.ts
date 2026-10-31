import { schema, withTransaction } from "@gestion-boutique/database";
import { afterAll, describe, expect, it } from "vitest";
import { createDevice, releaseDevices } from "./testDb";

afterAll(releaseDevices);

describe("harnais SQLite de test", () => {
  it("applique le bootstrap et toutes les migrations", async () => {
    const device = await createDevice();
    const rows = await device.db!.select().from(schema.syncOutbox);
    expect(rows).toEqual([]);
  });

  it("annule vraiment une transaction en échec", async () => {
    const { db } = await createDevice();
    await expect(
      withTransaction(async () => {
        await db!.insert(schema.syncState).values({ key: "k", value: "v" }).run();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db!.select().from(schema.syncState)).toEqual([]);
  });
});
