import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { root } from "./io.ts";
import { hashToken } from "./setup-auth.ts";

// Separate records keep a later email or SMTP retry from invalidating earlier links.
export class RemoteLinks {
  private db: Database;
  constructor(path = resolve(root, "data/remote-browser/links.sqlite")) {
    this.db = new Database(path);
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run("CREATE TABLE IF NOT EXISTS links(hash TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL)");
  }
  issue(now = Date.now()) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + 24 * 3600000;
    this.db.query("DELETE FROM links WHERE expiresAt<=?").run(now);
    this.db.query("INSERT INTO links(hash,expiresAt) VALUES(?,?)").run(hashToken(token), expiresAt);
    return { token, expiresAt };
  }
  consume(token: string, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return this.db.query("DELETE FROM links WHERE hash=? AND expiresAt>? RETURNING hash").get(hashToken(token), now) !== null;
  }
  close() { this.db.close(); }
}
