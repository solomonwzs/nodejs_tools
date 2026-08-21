import fs from "fs";
import http from "http";
import https from "https";
import path from "path";

const ALLOWED_FORWARD_HEADERS = [
  "content-type",
  "content-length",
  "authorization",
];
const MAX_BODY_SIZE = 10 * 1024 * 1024;

interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: Cost;
  headers?: Record<string, string>;
}

interface Config {
  port: number;
  http_proxy?: string;
  baseUrl: string;
  models: ModelConfig[];
  username: string;
  deviceId: string;
  authToken: string;
}

let config: Config;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function debug(message: string): void {
  if (process.env.DEBUG) {
    log(`[debug] ${message}`);
  }
}

function loadConfig(): Config {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const defaultConfigPath = path.join(homeDir, ".config", "gongfengproxy.json");
  const configPath = process.argv[2] || defaultConfigPath;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    log(`Loaded config from ${configPath}`);
    return parsed;
  } catch (e) {
    console.error(`Failed to load config from ${configPath}:`, e);
    process.exit(1);
  }
}

function findModelConfig(modelId: string): ModelConfig | undefined {
  return config.models.find((model) => model.id === modelId);
}

function composeTargetUrl(req: http.IncomingMessage): string {
  return config.baseUrl.replace(/\/+$/, "") + (req.url || "/");
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer,
  model: ModelConfig,
): Promise<void> {
  const target = new URL(targetUrl);
  const proxyTarget = config.http_proxy ? new URL(config.http_proxy) : target;
  const proxyPath = config.http_proxy
    ? targetUrl
    : target.pathname + target.search;

  const forwardedHeaders: Record<string, string> = {};
  for (const key of ALLOWED_FORWARD_HEADERS) {
    const value = req.headers[key];
    if (typeof value === "string") {
      forwardedHeaders[key] = value;
    }
  }

  const headers = {
    ...forwardedHeaders,
    host: target.host,
    ...model.headers,
    "X-Username": config.username,
    "DEVICE-ID": config.deviceId,
    "OAUTH-TOKEN": config.authToken,
  };

  const transport = config.http_proxy
    ? http
    : target.protocol === "https:"
      ? https
      : http;

  log(
    `model=${model.id} ${req.method} ${req.url} -> ${targetUrl} (${config.http_proxy ? `via ${config.http_proxy}` : "direct"})`,
  );
  debug(`forwarded headers: ${Object.keys(forwardedHeaders).join(", ") || "none"}; model headers: ${Object.keys(model.headers || {}).join(", ") || "none"}`);

  return new Promise((resolve, reject) => {
    const proxyReq = transport.request(
      {
        hostname: proxyTarget.hostname,
        port: proxyTarget.port || (config.http_proxy ? 80 : target.protocol === "https:" ? 443 : 80),
        path: proxyPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        log(`model=${model.id} <- ${proxyRes.statusCode || 502} ${targetUrl}`);
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on("end", resolve);
      },
    );

    proxyReq.on("error", (e) => {
      console.error("Proxy request error:", e);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway" }));
      }
      reject(e);
    });

    if (body.length > 0) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  let bodySize = 0;

  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bodySize += buffer.length;
    if (bodySize > MAX_BODY_SIZE) {
      log(`Payload too large: ${bodySize} bytes`);
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      return;
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks);
  let requestBody: { model?: unknown };
  try {
    requestBody = JSON.parse(body.toString());
  } catch {
    log(`Invalid JSON body for ${req.method} ${req.url}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (typeof requestBody.model !== "string" || requestBody.model.length === 0) {
    log(`Missing model field for ${req.method} ${req.url}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing model field" }));
    return;
  }

  const model = findModelConfig(requestBody.model);
  if (!model) {
    log(`Model not found: ${requestBody.model}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Model ${requestBody.model} not found` }));
    return;
  }

  await proxyRequest(req, res, composeTargetUrl(req), body, model);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const urlPath = new URL(req.url || "/", "http://localhost").pathname;
  if (urlPath !== "/v1/chat/completions") {
    log(`Not found: ${req.method} ${req.url}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  await handleChatCompletions(req, res);
}

function main(): void {
  config = loadConfig();

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      console.error("Request handling error:", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    }
  });

  server.on("error", (e) => {
    console.error("Server error:", e);
  });

  server.listen(config.port, () => {
    log(
      `GongfengProxy listening on :${config.port} (baseUrl=${config.baseUrl}${config.http_proxy ? `, http_proxy=${config.http_proxy}` : ""})`,
    );
    log(`models: ${config.models.map((model) => model.id).join(", ")}`);
  });
}

main();
