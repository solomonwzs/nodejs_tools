import { AdamsRegistry } from "./adams.js";
import { Config } from "./types.js";

export function generatePiModels(
  config: Config,
  adamsRegistry?: AdamsRegistry,
): Record<string, unknown> {
  const providers: Record<string, unknown> = {};

  if (config.adamsProxy && adamsRegistry) {
    providers.adams = {
      baseUrl: `http://localhost:${config.listen}/adams/v1`,
      api: "openai-completions",
      apiKey: "api-key",
      models: adamsRegistry.piModels,
    };
  }

  if (config.gongfengProxy) {
    providers.gongfeng = {
      baseUrl: `http://localhost:${config.listen}/gongfeng/v1`,
      api: "openai-completions",
      apiKey: "api-key",
      models: config.gongfengProxy.models.map(({ headers: _headers, ...model }) =>
        model.id.toLowerCase().startsWith("gpt")
          ? { ...model, compat: { supportsFinishReason: false } }
          : model,
      ),
    };
  }

  for (const provider of config.commProxy ?? []) {
    providers[provider.name] = {
      baseUrl: `http://localhost:${config.listen}/comm/${encodeURIComponent(provider.name)}/v1`,
      api: "openai-completions",
      apiKey: "api-key",
      models: provider.models.map((model) => ({ ...model })),
    };
  }

  return { providers };
}
