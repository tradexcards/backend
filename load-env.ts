/**
 * Load environment variables from .env or ../.env
 * Priority: .env (standalone) > ../.env (monorepo)
 */

import { existsSync } from "fs";

const envFile = existsSync(".env") ? ".env" : existsSync("../.env") ? "../.env" : null;

if (envFile) {
  const content = await Bun.file(envFile).text();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  console.log(`[env] Loaded from ${envFile}`);
} else {
  console.log("[env] No .env file found, using environment variables");
}
