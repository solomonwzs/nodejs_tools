import { AdamsRegistry } from "./adams.js";
import { loadConfig } from "./config.js";
import { GongfengRegistry } from "./gongfeng.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const adamsRegistry = config.adamsProxy
    ? new AdamsRegistry(config.adamsProxy)
    : undefined;
  const gongfengRegistry = config.gongfengProxy
    ? new GongfengRegistry(config.gongfengProxy)
    : undefined;
  await adamsRegistry?.initialize();
  await gongfengRegistry?.initialize();

  const server = createServer(config, adamsRegistry, gongfengRegistry);
  const host = config.allowLan ? "0.0.0.0" : "127.0.0.1";
  server.listen(config.listen, host, () => {
    console.log(`[${new Date().toISOString()}] TC LLM Proxy listening on ${host}:${config.listen}`);
    if (adamsRegistry) {
      console.log(
        `[${new Date().toISOString()}] Adams models: ${adamsRegistry.available ? adamsRegistry.piModels.map((model) => model.id).join(", ") || "none" : "unavailable"}`,
      );
    }
    if (gongfengRegistry) {
      console.log(
        `[${new Date().toISOString()}] Gongfeng models: ${gongfengRegistry.available ? gongfengRegistry.allModels.map((model) => model.id).join(", ") || "none" : "unavailable"}`,
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
