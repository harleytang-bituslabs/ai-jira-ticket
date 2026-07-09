import { describe, expect, it } from "vitest";
import { createSessionToken, hashPassword, verifyPassword, verifySessionToken } from "../src/server/session.js";

describe("password hashing (scrypt)", () => {
  it("verifies the original password and rejects others", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("salts are unique per hash", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("session tokens (signed cookie)", () => {
  const SECRET = "test-secret";

  it("round-trips the email", () => {
    const token = createSessionToken("a@x.com", SECRET);
    expect(verifySessionToken(token, SECRET)).toBe("a@x.com");
  });

  it("rejects tampered payloads and wrong secrets", () => {
    const token = createSessionToken("a@x.com", SECRET);
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "admin@x.com", exp: Date.now() + 9e9 })).toString("base64url");
    expect(verifySessionToken(`${forged}.${mac}`, SECRET)).toBeNull();
    expect(verifySessionToken(`${payload}.${mac}`, "other-secret")).toBeNull();
    expect(verifySessionToken("garbage", SECRET)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = createSessionToken("a@x.com", SECRET, -1000);
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });
});
