import os from "os";
import { requireObject, requireString } from "./config.js";
import { requestUpstream } from "./transport.js";
import { GongfengModel, GongfengProxyConfig } from "./types.js";

function joinUrl(baseUrl: string, requestPath: string): string {
  return baseUrl.replace(/\/+$/, "") + (requestPath.startsWith("/") ? requestPath : `/${requestPath}`);
}

function transformModel(value: unknown, label: string): GongfengModel {
  const raw = requireObject(value, `${label} model`);
  // The upstream /v1/model-configs response uses `key` as the model id.
  const id = requireString(raw.key, `${label} model.key`);
  const name = requireString(raw.name, `${label} model.name`);
  return {
    id,
    name,
    // Dynamic data does not carry reasoning/cost/headers; use safe defaults.
    reasoning: true,
    input: Array.isArray(raw.input) && raw.input.every((item) => typeof item === "string")
      ? (raw.input as string[])
      : ["text"],
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : 0,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Upstream expects X-Model-Name to equal the model display name.
    headers: { "X-Model-Name": name },
  };
}

export class GongfengRegistry {
  private models: GongfengModel[] = [];
  private ready = false;
  private refreshPromise: Promise<void> | undefined;

  constructor(private readonly config: GongfengProxyConfig) {}

  get available(): boolean {
    return this.ready;
  }

  get allModels(): GongfengModel[] {
    return this.models.map((model) => ({ ...model }));
  }

  findModel(modelId: string): GongfengModel | undefined {
    return this.models.find((item) => item.id === modelId);
  }

  async initialize(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const [chatModels, imageModels] = await Promise.all([
          this.fetchModels(),
          this.fetchImageModels(),
        ]);
        // Chat models take precedence; image models fill in ids not already present.
        const ids = new Set(chatModels.map((model) => model.id));
        this.models = [
          ...chatModels,
          ...imageModels.filter((model) => !ids.has(model.id)),
        ];
        this.ready = true;
        console.log(
          `[${new Date().toISOString()}] Discovered ${this.models.length} Gongfeng model(s) ` +
            `(${chatModels.length} chat, ${imageModels.length} image) from ${this.config.baseUrl}`,
        );
      } catch (error) {
        console.error("Failed to refresh Gongfeng model cache; keeping the previous cache:", error);
      }
    })().finally(() => {
      this.refreshPromise = undefined;
    });

    return this.refreshPromise;
  }

  private async fetchModels(): Promise<GongfengModel[]> {
    const modelsUrl = joinUrl(this.config.baseUrl, "/v1/model-configs");
    const target = new URL(modelsUrl);
    let result: GongfengModel[] = [];

    console.log(
      `[${new Date().toISOString()}] provider=gongfeng discovery GET target=${modelsUrl} request_size=0`,
    );
    await requestUpstream({
      url: modelsUrl,
      method: "GET",
      headers: {
        accept: "application/json",
        host: target.host,
        "X-Username": this.config.username,
        "DEVICE-ID": this.config.deviceId,
        "OAUTH-TOKEN": this.config.authToken,
      },
      httpProxy: this.config.httpProxy,
      httpsProxy: this.config.httpsProxy,
    }, async (response) => {
      console.log(
        `[${new Date().toISOString()}] provider=gongfeng discovery upstream_status=${response.statusCode || 502} target=${modelsUrl}`,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${modelsUrl} returned HTTP ${response.statusCode || 0}`);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!Array.isArray(parsed)) {
        throw new Error(`${modelsUrl} response must be an array`);
      }
      result = parsed.map((model) => transformModel(model, modelsUrl));
    });
    return result;
  }

  private async fetchImageModels(): Promise<GongfengModel[]> {
    const modelsUrl = joinUrl(this.config.baseUrl, "/v1/image-model-configs");
    const target = new URL(modelsUrl);
    let result: GongfengModel[] = [];

    console.log(
      `[${new Date().toISOString()}] provider=gongfeng-image discovery GET target=${modelsUrl} request_size=0`,
    );
    await requestUpstream({
      url: modelsUrl,
      method: "GET",
      headers: {
        accept: "application/json",
        host: target.host,
        "X-Username": this.config.username,
        "DEVICE-ID": this.config.deviceId,
        "OAUTH-TOKEN": this.config.authToken,
        "x-platform": `${os.type()}/${os.machine()}`,
      },
      httpProxy: this.config.httpProxy,
      httpsProxy: this.config.httpsProxy,
    }, async (response) => {
      console.log(
        `[${new Date().toISOString()}] provider=gongfeng-image discovery upstream_status=${response.statusCode || 502} target=${modelsUrl}`,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${modelsUrl} returned HTTP ${response.statusCode || 0}`);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!Array.isArray(parsed)) {
        throw new Error(`${modelsUrl} response must be an array`);
      }
      result = parsed.map((model) => transformModel(model, modelsUrl));
    });
    return result;
  }
}
