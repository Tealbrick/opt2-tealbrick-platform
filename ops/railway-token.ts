// The operator's Railway CLI login, for the ops scripts (promote, railway-deploy). Prints no token.
// CLI 4 stored a long-lived `user.token`. CLI 5 (OAuth) stores `user.accessToken` (about 1 h), `user.refreshToken` and
// `user.tokenExpiresAt` (epoch seconds), and leaves `user.token` null. Near expiry, any CLI command refreshes the access
// token, so `railway whoami` is run once and the file is read again.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RailwayCliUser {
  token?: string | null;
  accessToken?: string | null;
  tokenExpiresAt?: number | null;
}

/** Refresh when less than this is left (a promote or deploy run makes many calls). */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** The usable token of a parsed `user` block, or null. Pure (unit-tested). */
export function pickToken(u: RailwayCliUser): string | null {
  return u.accessToken || u.token || null;
}

/** True when the CLI 5 access token is missing its expiry or expires within the margin. Pure (unit-tested). */
export function needsRefresh(u: RailwayCliUser, nowMs: number): boolean {
  if (!u.accessToken) return false;
  return typeof u.tokenExpiresAt !== "number" || u.tokenExpiresAt * 1000 - nowMs < REFRESH_MARGIN_MS;
}

function readUser(): RailwayCliUser {
  const path = join(homedir(), ".railway/config.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { user?: RailwayCliUser }).user ?? {};
}

export function railwayToken(): string {
  let u = readUser();
  if (needsRefresh(u, Date.now())) {
    spawnSync("railway", ["whoami"], { stdio: "ignore" });
    u = readUser();
  }
  const t = pickToken(u);
  if (!t) throw new Error("not logged in to the Railway CLI (run `railway login`)");
  return t;
}
