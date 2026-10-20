// C293a: where the website deploy plugin image lives. One place for the publish script, the setup script and the activate script.
// The image is published by ops/site-deploy-plugin-publish.ts to the Forgejo container registry; every version is a NEW tag, never reused.
import { readFileSync } from "node:fs";

export const REGISTRY_HOST = "forge.polygonface.com";
export const IMAGE_NAME = `${REGISTRY_HOST}/polygonface/tb-site-deploy`;
export const VERSION_FILE = new URL("./VERSION", import.meta.url);
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** The plugin version (contents of VERSION). Refuses anything but X.Y.Z. */
export function pluginVersion(read: () => string = () => readFileSync(VERSION_FILE, "utf8")): string {
  const v = read().trim();
  if (!VERSION_RE.test(v)) throw new Error(`ops/site-deploy-plugin/VERSION must hold X.Y.Z (got ${JSON.stringify(v.slice(0, 20))})`);
  return v;
}

/** The one image reference the Woodpecker secrets are limited to and the website workflow runs: name:version. */
export function pluginImage(version: string = pluginVersion()): string {
  return `${IMAGE_NAME}:${version}`;
}

export const DIGEST_FILE = new URL("./IMAGE-DIGEST", import.meta.url);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The recorded digest of the published image: `<VERSION> sha256:<64 hex>` in IMAGE-DIGEST (written by the publish script). null while it is the
 *  placeholder or belongs to another version. */
export function recordedDigest(version: string = pluginVersion(), read: () => string = () => readFileSync(DIGEST_FILE, "utf8")): string | null {
  const [v, digest] = read().trim().split(/\s+/);
  return v === version && digest !== undefined && DIGEST_RE.test(digest) ? digest : null;
}

/** The digest-pinned reference: name:tag@sha256:<digest> (what the website workflow runs). null while the image is not recorded. */
export function pinnedImage(version: string = pluginVersion(), digest: string | null = recordedDigest(version)): string | null {
  return digest ? `${pluginImage(version)}@${digest}` : null;
}

/** A valid secret image filter value: name:tag or name:tag@sha256:<digest>, of THIS image only. */
export function checkFilter(value: string): string | null {
  const m = /^forge\.polygonface\.com\/polygonface\/tb-site-deploy:(\d+\.\d+\.\d+)(@sha256:[0-9a-f]{64})?$/.exec(value);
  if (!m) return "the image filter must be forge.polygonface.com/polygonface/tb-site-deploy:<X.Y.Z> or ...:<X.Y.Z>@sha256:<64 hex>";
  if (m[1] !== pluginVersion()) return `the image filter has the version ${m[1]} but ops/site-deploy-plugin/VERSION is ${pluginVersion()}`;
  return null;
}
