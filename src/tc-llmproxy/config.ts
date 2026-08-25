import fs from "fs";
import http from "http";
import path from "path";
import { Config } from "./types.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateHttpUrl(value: unknown, field: string): void {
  const text = requireString(value, field);
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must use http: or https:`);
  }
}

function validateProxySettings(value: Record<string, unknown>, field: string): void {
  if (value.httpProxy !== undefined) validateHttpUrl(value.httpProxy, `${field}.httpProxy`);
  if (value.httpsProxy !== undefined) validateHttpUrl(value.httpsProxy, `${field}.httpsProxy`);
}

function validateHeaders(value: unknown, field: string): void {
  if (value === undefined) return;
  const headers = requireObject(value, field);
  for (const [name, headerValue] of Object.entries(headers)) {
    http.validateHeaderName(name);
    if (typeof headerValue !== "string") {
      throw new Error(`${field}.${name} must be a string`);
    }
    http.validateHeaderValue(name, headerValue);
  }
}

function validateUniqueModelIds(
  models: unknown[],
  field: string,
  validate: (model: Record<string, unknown>, index: number) => string,
): void {
  const seen = new Set<string>();
  models.forEach((value, index) => {
    const id = validate(requireObject(value, `${field}[${index}]`), index);
    if (seen.has(id)) {
      throw new Error(`${field}[${index}] duplicates model ${JSON.stringify(id)}`);
    }
    seen.add(id);
  });
}

function validateConfig(value: unknown): asserts value is Config {
  const root = requireObject(value, "config");
  if (!Number.isInteger(root.listen) || (root.listen as number) < 1 || (root.listen as number) > 65535) {
    throw new Error("listen must be an integer between 1 and 65535");
  }

  if (root.adamsProxy !== undefined) {
    const adams = requireObject(root.adamsProxy, "adamsProxy");
    validateProxySettings(adams, "adamsProxy");
    validateHttpUrl(adams.baseUrl, "adamsProxy.baseUrl");
    validateHeaders(adams.extHeaders, "adamsProxy.extHeaders");
    if (!Array.isArray(adams.models) || adams.models.length === 0) {
      throw new Error("adamsProxy.models must be a non-empty array");
    }
    const serviceIds = new Set<number>();
    adams.models.forEach((value, index) => {
      const service = requireObject(value, `adamsProxy.models[${index}]`);
      requireString(service.name, `adamsProxy.models[${index}].name`);
      if (!Number.isInteger(service.id) || (service.id as number) < 0) {
        throw new Error(`adamsProxy.models[${index}].id must be a non-negative integer`);
      }
      if (serviceIds.has(service.id as number)) {
        throw new Error(`adamsProxy.models[${index}].id duplicates service ${service.id}`);
      }
      serviceIds.add(service.id as number);
    });
  }

  if (root.gongfengProxy !== undefined) {
    const gongfeng = requireObject(root.gongfengProxy, "gongfengProxy");
    validateProxySettings(gongfeng, "gongfengProxy");
    validateHttpUrl(gongfeng.baseUrl, "gongfengProxy.baseUrl");
    requireString(gongfeng.username, "gongfengProxy.username");
    requireString(gongfeng.deviceId, "gongfengProxy.deviceId");
    requireString(gongfeng.authToken, "gongfengProxy.authToken");
    if (!Array.isArray(gongfeng.models)) throw new Error("gongfengProxy.models must be an array");
    validateUniqueModelIds(gongfeng.models, "gongfengProxy.models", (model, index) => {
      const field = `gongfengProxy.models[${index}]`;
      const id = requireString(model.id, `${field}.id`);
      requireString(model.name, `${field}.name`);
      if (typeof model.reasoning !== "boolean") throw new Error(`${field}.reasoning must be a boolean`);
      if (!Array.isArray(model.input) || !model.input.every((item) => typeof item === "string")) {
        throw new Error(`${field}.input must be a string array`);
      }
      if (typeof model.contextWindow !== "number") throw new Error(`${field}.contextWindow must be a number`);
      if (typeof model.maxTokens !== "number") throw new Error(`${field}.maxTokens must be a number`);
      const cost = requireObject(model.cost, `${field}.cost`);
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
        if (typeof cost[key] !== "number") throw new Error(`${field}.cost.${key} must be a number`);
      }
      validateHeaders(model.headers, `${field}.headers`);
      return id;
    });
  }

  if (root.commProxy !== undefined) {
    if (!Array.isArray(root.commProxy)) throw new Error("commProxy must be an array");
    const providerNames = new Set<string>();
    root.commProxy.forEach((value, providerIndex) => {
      const provider = requireObject(value, `commProxy[${providerIndex}]`);
      validateProxySettings(provider, `commProxy[${providerIndex}]`);
      validateHttpUrl(provider.baseUrl, `commProxy[${providerIndex}].baseUrl`);
      const name = requireString(provider.name, `commProxy[${providerIndex}].name`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name)) {
        throw new Error(`commProxy[${providerIndex}].name is not a valid path segment`);
      }
      if (name === "adams" || name === "gongfeng" || providerNames.has(name)) {
        throw new Error(`commProxy[${providerIndex}].name duplicates or uses reserved provider ${JSON.stringify(name)}`);
      }
      providerNames.add(name);
      if (!Array.isArray(provider.models)) {
        throw new Error(`commProxy[${providerIndex}].models must be an array`);
      }
      validateUniqueModelIds(provider.models, `commProxy[${providerIndex}].models`, (model, modelIndex) =>
        requireString(model.id, `commProxy[${providerIndex}].models[${modelIndex}].id`),
      );
    });
  }
}

export function loadConfig(): Config {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const defaultPath = path.join(homeDir, ".config", "tc-llmproxy.json");
  const configPath = process.argv[2] || defaultPath;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    validateConfig(parsed);
    console.log(`[${new Date().toISOString()}] Loaded config from ${configPath}`);
    return parsed;
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error);
    process.exit(1);
  }
}
