import { AdamsRegistry } from "./adams.js";
import { GongfengRegistry } from "./gongfeng.js";
import { Config } from "./types.js";

export function generatePiModels(
  config: Config,
  adamsRegistry?: AdamsRegistry,
  gongfengRegistry?: GongfengRegistry,
): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  const ip = config.ip ?? "localhost";
  // IPv6 literals need brackets in URLs (listen() uses the unbracketed address).
  const host = ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
  const baseUrl = `http://${host}:${config.listen}`;

  if (config.adamsProxy && adamsRegistry) {
    providers.adams = {
      baseUrl: `${baseUrl}/adams/v1`,
      api: "openai-completions",
      apiKey: "api-key",
      models: adamsRegistry.piModels.map((model) => ({ ...model, reasoning: true })),
    };
  }

  if (config.gongfengProxy && gongfengRegistry) {
    providers.gongfeng = {
      baseUrl: `${baseUrl}/gongfeng/v1`,
      api: "openai-completions",
      apiKey: "api-key",
      // Include both chat and text-to-image models (imageOnly) in the gongfeng
      // provider; image models are served via /gongfeng/v1/images/generations.
      models: gongfengRegistry.allModels.map(({ headers: _headers, imageOnly: _imageOnly, ...model }) => {
        const modelId = model.id.toLowerCase();
        if (modelId.startsWith("gpt")) {
          return { ...model, compat: { supportsFinishReason: false } };
        }
        if (modelId.startsWith("deepseek")) {
          return { ...model, compat: { supportsDeveloperRole: false } };
        }
        return model;
      }),
    };
  }

  for (const provider of config.commProxy ?? []) {
    providers[provider.name] = {
      baseUrl: `${baseUrl}/comm/${encodeURIComponent(provider.name)}/v1`,
      api: "openai-completions",
      apiKey: "api-key",
      models: provider.models.map((model) => ({ ...model })),
    };
  }

  return { providers };
}
