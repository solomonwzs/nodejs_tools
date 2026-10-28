import { loadConfig } from "./config.js";
import { createProxyServer } from "./server.js";

function main(): void {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: node dist/httpproxy/index.js <config.json>");
  const config = loadConfig(configPath);
  const host = config.allowLan ? "0.0.0.0" : "127.0.0.1";
  const server = createProxyServer(config);
  server.once("error", (error) => {
    console.error("HTTP proxy server error:", error.message);
    process.exitCode = 1;
  });
  server.listen(config.listen, host, () => {
    console.log(`HTTP proxy listening on http://${host}:${config.listen}`);
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
