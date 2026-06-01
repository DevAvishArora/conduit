import { describe, expect, it } from "vitest";
import { assertUrlAllowed, isBlockedIp, validatingLookup } from "../src/handlers/ssrf.js";

describe("SSRF guard (§7.1.3)", () => {
  describe("isBlockedIp", () => {
    it("blocks IPv4 private ranges", () => {
      expect(isBlockedIp("10.0.0.1")).toBe(true);
      expect(isBlockedIp("172.16.0.5")).toBe(true);
      expect(isBlockedIp("172.31.255.254")).toBe(true);
      expect(isBlockedIp("192.168.1.1")).toBe(true);
    });
    it("blocks loopback / link-local / CGNAT", () => {
      expect(isBlockedIp("127.0.0.1")).toBe(true);
      expect(isBlockedIp("169.254.169.254")).toBe(true); // cloud metadata
      expect(isBlockedIp("100.64.0.1")).toBe(true);
    });
    it("blocks IPv6 loopback / ULA / link-local", () => {
      expect(isBlockedIp("::1")).toBe(true);
      expect(isBlockedIp("fc00::1")).toBe(true);
      expect(isBlockedIp("fe80::1")).toBe(true);
    });
    it("blocks IPv4-mapped IPv6 addresses", () => {
      expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
      expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
    });
    it("allows obvious public IPs", () => {
      expect(isBlockedIp("1.1.1.1")).toBe(false);
      expect(isBlockedIp("8.8.8.8")).toBe(false);
      expect(isBlockedIp("2606:4700::1111")).toBe(false);
    });
    it("blocks unparseable inputs (default-deny)", () => {
      expect(isBlockedIp("not.an.ip")).toBe(true);
      expect(isBlockedIp("")).toBe(true);
    });
  });

  describe("assertUrlAllowed", () => {
    it("rejects non-http(s) schemes", () => {
      expect(() => assertUrlAllowed("file:///etc/passwd", [])).toThrow();
      expect(() => assertUrlAllowed("javascript:alert(1)", [])).toThrow();
    });
    it("passes a public URL with no allowlist", () => {
      expect(() => assertUrlAllowed("https://api.example.com/x", [])).not.toThrow();
    });
    it("enforces the allowlist when set", () => {
      expect(() => assertUrlAllowed("https://api.example.com/x", ["example.com"])).not.toThrow();
      expect(() => assertUrlAllowed("https://other.com/x", ["example.com"])).toThrow();
    });
    it("rejects malformed urls", () => {
      expect(() => assertUrlAllowed("not a url", [])).toThrow();
    });
  });

  describe("validatingLookup", () => {
    // The wrapper must preserve the callback shape that node's http(s) module
    // expects in both modes (review fix from this round): {all:false} returns
    // a string + family; {all:true} returns the array unchanged. Collapsing
    // the array form breaks net.emitLookup with ERR_INVALID_IP_ADDRESS.
    it("passes through a public string address (all:false)", async () => {
      const lookup = validatingLookup(true);
      await new Promise<void>((resolve, reject) => {
        // Use a literal IP so we don't hit DNS in tests
        (lookup as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)(
          "1.1.1.1",
          { family: 0 },
          (err: Error | null, addr: unknown, family: unknown) => {
            try {
              expect(err).toBeFalsy();
              expect(addr).toBe("1.1.1.1");
              expect(typeof family).toBe("number");
              resolve();
            } catch (e) {
              reject(e as Error);
            }
          },
        );
      });
    });

    it("blocks a string address that resolves to a private IP", async () => {
      const lookup = validatingLookup(true);
      await new Promise<void>((resolve, reject) => {
        (lookup as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)(
          "10.0.0.1",
          { family: 0 },
          (err: Error | null) => {
            try {
              expect(err).toBeTruthy();
              expect(err!.message).toMatch(/blocked private address/);
              resolve();
            } catch (e) {
              reject(e as Error);
            }
          },
        );
      });
    });

    it("preserves the array shape when called with all:true", async () => {
      const lookup = validatingLookup(true);
      await new Promise<void>((resolve, reject) => {
        (lookup as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)(
          "1.1.1.1",
          { family: 0, all: true },
          (err: Error | null, addrs: unknown) => {
            try {
              expect(err).toBeFalsy();
              expect(Array.isArray(addrs)).toBe(true);
              // Every entry is the {address, family} shape Node expects
              for (const a of addrs as Array<{ address: string }>) {
                expect(typeof a.address).toBe("string");
              }
              resolve();
            } catch (e) {
              reject(e as Error);
            }
          },
        );
      });
    });
  });
});
