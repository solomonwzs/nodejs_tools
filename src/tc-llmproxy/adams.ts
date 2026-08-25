import { requireObject, requireString } from "./config.js";
import { requestUpstream } from "./transport.js";
import {
  AdamsPiModel,
  AdamsProxyConfig,
  DuplicateAdamsModelError,
  ModelCost,
} from "./types.js";

interface DiscoveryResult {
  successfulTargets: number;
  models: AdamsPiModel[];
  routes: Map<string, string>;
}

function joinUrl(baseUrl: string, requestPath: string): string {
  return baseUrl.replace(/\/+$/, "") + (requestPath.startsWith("/") ? requestPath : `/${requestPath}`);
}

function transformModel(value: unknown, targetUrl: string): AdamsPiModel {
  const model = requireObject(value, `${targetUrl} model`);
  const output: AdamsPiModel = {
    id: requireString(model.id, `${targetUrl} model.id`),
  };

  if (typeof model.name === "string") output.name = model.name;
  if (typeof model.reasoning === "boolean") output.reasoning = model.reasoning;
  if (Array.isArray(model.input) && model.input.every((item) => typeof item === "string")) {
    output.input = model.input as string[];
  }
  if (typeof model.contextWindow === "number") {
    output.contextWindow = model.contextWindow;
  } else if (typeof model.max_model_len === "number") {
    output.contextWindow = model.max_model_len;
  }
  if (typeof model.maxTokens === "number") output.maxTokens = model.maxTokens;
  if (requireOptionalCost(model.cost)) output.cost = model.cost;
  return output;
}

function requireOptionalCost(value: unknown): value is ModelCost {
  if (!requireCostObject(value)) return false;
  return [value.input, value.output, value.cacheRead, value.cacheWrite]
    .every((item) => typeof item === "number");
}

function requireCostObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AdamsRegistry {
  private models: AdamsPiModel[] = [];
  private routes = new Map<string, string>();
  private ready = false;
  private refreshPromise: Promise<void> | undefined;

  constructor(private readonly config: AdamsProxyConfig) {}

  get available(): boolean {
    return this.ready;
  }

  get piModels(): AdamsPiModel[] {
    return this.models.map((model) => ({ ...model }));
  }

  findTarget(modelId: string): string | undefined {
    return this.routes.get(modelId);
  }

  async initialize(): Promise<void> {
    await this.refresh(true);
  }

  async refresh(initial = false): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const discovery = await this.discover();
        if (discovery.successfulTargets === 0) {
          console.error("Adams model discovery unavailable; keeping the previous cache");
          return;
        }
        this.models = discovery.models;
        this.routes = discovery.routes;
        this.ready = true;
        console.log(
          `[${new Date().toISOString()}] Discovered ${this.models.length} Adams model(s) from ${discovery.successfulTargets} target(s)`,
        );
      } catch (error) {
        if (initial && error instanceof DuplicateAdamsModelError) throw error;
        console.error("Failed to refresh Adams model cache; keeping the previous cache:", error);
      }
    })().finally(() => {
      this.refreshPromise = undefined;
    });

    return this.refreshPromise;
  }

  private async fetchTarget(targetUrl: string): Promise<AdamsPiModel[]> {
    const modelsUrl = joinUrl(targetUrl, "/v1/models");
    const target = new URL(modelsUrl);
    let result: AdamsPiModel[] = [];

    console.log(
      `[${new Date().toISOString()}] provider=adams discovery GET target=${modelsUrl} request_size=0`,
    );
    await requestUpstream({
      url: modelsUrl,
      method: "GET",
      headers: { host: target.host, ...this.config.extHeaders },
      httpProxy: this.config.httpProxy,
      httpsProxy: this.config.httpsProxy,
    }, async (response) => {
      console.log(
        `[${new Date().toISOString()}] provider=adams discovery upstream_status=${response.statusCode || 502} target=${modelsUrl}`,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${modelsUrl} returned HTTP ${response.statusCode || 0}`);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
      const root = requireObject(parsed, `${modelsUrl} response`);
      if (!Array.isArray(root.data)) {
        throw new Error(`${modelsUrl} response.data must be an array`);
      }
      result = root.data.map((model) => transformModel(model, targetUrl));
    });
    return result;
  }

  private async discover(): Promise<DiscoveryResult> {
    const routes = new Map<string, string>();
    const models: AdamsPiModel[] = [];
    const seenTargets = new Set<string>();
    let successfulTargets = 0;

    for (const service of this.config.models) {
      const targetUrl = joinUrl(this.config.baseUrl, `/service/${service.id}`);
      if (seenTargets.has(targetUrl)) continue;
      seenTargets.add(targetUrl);
      try {
        const targetModels = await this.fetchTarget(targetUrl);
        successfulTargets += 1;
        for (const model of targetModels) {
          const previousTarget = routes.get(model.id);
          if (previousTarget) {
            throw new DuplicateAdamsModelError(
              `Adams model ${JSON.stringify(model.id)} is returned by both ${previousTarget} and ${targetUrl}`,
            );
          }
          routes.set(model.id, targetUrl);
          models.push(model);
        }
      } catch (error) {
        if (error instanceof DuplicateAdamsModelError) throw error;
        console.error(`Failed to discover Adams models from ${targetUrl}:`, error);
      }
    }

    return { successfulTargets, models, routes };
  }
}
