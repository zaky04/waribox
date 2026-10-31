import { describe, expect, it } from "vitest";
import { MasterPairingPayload } from "./masterPairingPayload";

const VALID_INIT = {
  masterId: "master-1",
  masterName: "PC Boutique principale",
  host: "192.168.1.42",
  port: 51820,
  token: "a1b2c3d4",
};

describe("MasterPairingPayload", () => {
  it("round-trips through encode/tryDecode", () => {
    const payload = new MasterPairingPayload(VALID_INIT);
    const decoded = MasterPairingPayload.tryDecode(payload.encode());

    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(payload);
  });

  it("returns null for content that isn't JSON", () => {
    expect(MasterPairingPayload.tryDecode("EAN-13:1234567890128")).toBeNull();
  });

  it("returns null for JSON that isn't an object", () => {
    expect(MasterPairingPayload.tryDecode("42")).toBeNull();
    expect(MasterPairingPayload.tryDecode("[1,2,3]")).toBeNull();
  });

  it("returns null for an unknown format version", () => {
    expect(MasterPairingPayload.tryDecode(JSON.stringify({ ...VALID_INIT, v: 2 }))).toBeNull();
  });

  it.each(["masterId", "masterName", "host", "token"] as const)(
    "returns null when %s is missing or empty",
    (field) => {
      const withMissing = { v: 1, ...VALID_INIT, [field]: "" };
      expect(MasterPairingPayload.tryDecode(JSON.stringify(withMissing))).toBeNull();
    },
  );

  it("returns null for a port out of range", () => {
    expect(MasterPairingPayload.tryDecode(JSON.stringify({ v: 1, ...VALID_INIT, port: 0 }))).toBeNull();
    expect(MasterPairingPayload.tryDecode(JSON.stringify({ v: 1, ...VALID_INIT, port: 70000 }))).toBeNull();
    expect(MasterPairingPayload.tryDecode(JSON.stringify({ v: 1, ...VALID_INIT, port: 1.5 }))).toBeNull();
  });
});
