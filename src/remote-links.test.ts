import { test, expect } from "bun:test";
import { RemoteLinks } from "./remote-links.ts";
test("email links are fresh per send, independent, single-use, and expire", () => {
  const links = new RemoteLinks(":memory:");
  try {
    const first = links.issue(1000), retry = links.issue(2000);
    expect(first.token).not.toBe(retry.token);
    expect(retry.expiresAt).toBe(2000 + 24 * 3600000);
    expect(links.consume(first.token, 3000)).toBe(true);
    expect(links.consume(first.token, 3000)).toBe(false);
    expect(links.consume(retry.token, retry.expiresAt)).toBe(false);
    const next = links.issue(4000);
    expect(links.consume(next.token, 4001)).toBe(true);
    expect(links.consume("invalid", 4001)).toBe(false);
  } finally { links.close(); }
});
