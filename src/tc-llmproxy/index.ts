import { AdamsRegistry } from "./adams.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const adamsRegistry = config.adamsProxy
    ? new AdamsRegistry(config.adamsProxy)
    : undefined;
  await adamsRegistry?.initialize();

  const server = createServer(config, adamsRegistry);
  server.listen(config.listen, () => {
    console.log(`[${new Date().toISOString()}] TC LLM Proxy listening on :${config.listen}`);
    if (adamsRegistry) {
      console.log(
        `[${new Date().toISOString()}] Adams models: ${adamsRegistry.available ? adamsRegistry.piModels.map((model) => model.id).join(", ") || "none" : "unavailable"}`,
      );
    }
    if (config.gongfengProxy) {
      console.log(
        `[${new Date().toISOString()}] Gongfeng models: ${config.gongfengProxy.models.map((model) => model.id).join(", ") || "none"}`,
      );
    }
    if (config.commProxy) {
      console.log(
        `[${new Date().toISOString()}] Common providers: ${config.commProxy.map((provider) => provider.name).join(", ") || "none"}`,
      );
    }
  });
}

main().catch((error) => {
  console.error("Failed to start TC LLM Proxy:", error);
  process.exit(1);
});
