import fs from "fs";

export interface Config {
  listen: number;
  allowLan?: boolean;
  httpProxy?: string;
  httpsProxy?: string;
}

export function loadConfig(path: string): Config {
  const value: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Config must be an object");
  }
  const config = value as Config;
  if (!Number.isInteger(config.listen) || config.listen < 1 || config.listen > 65535) {
    throw new Error("listen must be an integer between 1 and 65535");
  }
  if (config.allowLan !== undefined && typeof config.allowLan !== "boolean") {
    throw new Error("allowLan must be a boolean");
  }
  for (const key of ["httpProxy", "httpsProxy"] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${key} must be a URL string`);
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`${key} must be an HTTP(S) proxy origin`);
    }
  }
  return config;
}
