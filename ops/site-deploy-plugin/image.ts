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
