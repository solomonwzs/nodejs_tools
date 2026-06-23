import http from "http";
import fs from "fs";
import path from "path";
import { URL } from "url";

const ALLOWED_FORWARD_HEADERS = [
  "content-type",
  "content-length",
  "authorization",
];
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Verbose logs gated behind DEBUG=1 so production stays quiet.
function debug(msg: string): void {
  if (process.env.DEBUG) {
    console.log(`[${new Date().toISOString()}] [debug] ${msg}`);
  }
}

interface ModelConfig {
  name: string;
  id: number;
}

interface Config {
  listen: number;
  base_url: string;
  http_proxy?: string;
  ext_headers?: Record<string, string>;
  models: ModelConfig[];
}

let config: Config;

function loadConfig(): Config {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const defaultConfigPath = path.join(homeDir, ".config", "adamsproxy2.json");
  const configPath = process.argv[2] || defaultConfigPath;
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    log(`Loaded config from ${configPath}`);
    return parsed;
  } catch (e) {
    console.error(`Failed to load config from ${configPath}:`, e);
    process.exit(1);
  }
}

function findModelConfig(modelName: string): ModelConfig | undefined {
  return config.models.find((m) => m.name === modelName);
}

function composeTargetUrl(model: ModelConfig): string {
  const base = config.base_url.replace(/\/+$/, "");
  return `${base}/service/${model.id}`;
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer,
  httpProxy?: string,
  extHeaders?: Record<string, string>,
): Promise<void> {
  const target = new URL(targetUrl);
  const reqPath = req.url || "/";

  let proxyTarget = target;
  let proxyPath: string;
  if (httpProxy) {
    proxyTarget = new URL(httpProxy);
    proxyPath = targetUrl.replace(/\/+$/, "") + reqPath;
  } else {
    const basePath = target.pathname.replace(/\/+$/, "");
    proxyPath = basePath + reqPath;
  }

  const filteredHeaders: Record<string, string> = {};
  for (const key of ALLOWED_FORWARD_HEADERS) {
    const value = req.headers[key];
    if (typeof value === "string") {
      filteredHeaders[key] = value;
    }
  }

  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: proxyTarget.hostname,
      port: proxyTarget.port,
      path: proxyPath,
      method: req.method,
      headers: {
        ...filteredHeaders,
        host: target.host,
        ...extHeaders,
      },
    };

    debug(
      `>> ${req.method} ${targetUrl}${reqPath} (via ${httpProxy ? httpProxy : "direct"})`,
    );

    const proxyReq = http.request(options, (proxyRes) => {
      debug(`<< ${proxyRes.statusCode || 500} ${targetUrl}`);
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on("end", resolve);
    });

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

async function handleProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  let bodySize = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    bodySize += buf.length;
    if (bodySize > MAX_BODY_SIZE) {
      debug(`Payload too large: ${bodySize} bytes`);
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      return;
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);
  debug(`Request body size: ${body.length} bytes`);

  let requestBody: any;
  try {
    requestBody = JSON.parse(body.toString());
  } catch (e) {
    debug(`Invalid JSON body: ${body.toString().slice(0, 200)}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const modelName = requestBody.model;
  if (!modelName) {
    debug("Missing model field in request body");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing model field" }));
    return;
  }

  const modelConfig = findModelConfig(modelName);
  if (!modelConfig) {
    debug(`Model not found: ${modelName}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Model ${modelName} not found` }));
    return;
  }

  const targetUrl = composeTargetUrl(modelConfig);
  log(`model=${modelName} id=${modelConfig.id} -> ${targetUrl}`);

  await proxyRequest(
    req,
    res,
    targetUrl,
    body,
    config.http_proxy,
    config.ext_headers,
  );
}

interface ModelInfo {
  id: string;
  [key: string]: any;
}

async function fetchModelsFromTarget(
  targetUrl: string,
  httpProxy?: string,
  extHeaders?: Record<string, string>,
): Promise<ModelInfo[]> {
  return new Promise((resolve) => {
    const target = new URL(targetUrl);
    const basePath = target.pathname.replace(/\/+$/, "");
    const modelsPath = basePath + "/v1/models";

    let proxyTarget = target;
    let proxyPath = modelsPath;
    if (httpProxy) {
      proxyTarget = new URL(httpProxy);
      proxyPath = targetUrl.replace(/\/+$/, "") + "/v1/models";
    }

    const options: http.RequestOptions = {
      hostname: proxyTarget.hostname,
      port: proxyTarget.port,
      path: proxyPath,
      method: "GET",
      headers: {
        host: target.host,
        ...extHeaders,
      },
    };

    debug(
      `>> GET ${targetUrl}/v1/models (via ${httpProxy ? httpProxy : "direct"})`,
    );

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const models = data.data || [];
          debug(`<< ${res.statusCode} ${targetUrl}/v1/models (${models.length} models)`);
          resolve(models);
        } catch (e) {
          console.error(
            `Failed to parse models response from ${targetUrl}:`,
            e,
          );
          resolve([]);
        }
      });
    });

    req.on("error", (e) => {
      console.error(`Failed to fetch models from ${targetUrl}:`, e);
      resolve([]);
    });

    req.end();
  });
}

async function handleModelsInfo(res: http.ServerResponse): Promise<void> {
  const allModels: ModelInfo[] = [];
  const seenTargets = new Set<string>();

  for (const model of config.models) {
    const targetUrl = composeTargetUrl(model);
    if (seenTargets.has(targetUrl)) {
      debug(`Skipping duplicate target: ${targetUrl}`);
      continue;
    }
    seenTargets.add(targetUrl);

    const models = await fetchModelsFromTarget(
      targetUrl,
      config.http_proxy,
      config.ext_headers,
    );
    debug(`Got ${models.length} models from ${targetUrl}`);
    allModels.push(...models);
  }

  log(`/v1/models: ${allModels.length} models from ${seenTargets.size} target(s)`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: allModels }));
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const parsed = new URL(req.url || "/", "http://localhost");
  const urlPath = parsed.pathname;

  log(`<-- ${req.method} ${req.url}`);
  res.on("finish", () => {
    log(`--> ${res.statusCode} ${req.method} ${req.url}`);
  });

  if (urlPath === "/v1/models") {
    await handleModelsInfo(res);
    return;
  }

  if (urlPath === "/v1/chat/completions" || urlPath === "/v1/messages") {
    await handleProxy(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
}

function main() {
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

  // Safety nets: never exit on unexpected exceptions.
  process.on("uncaughtException", (e) => {
    console.error("Uncaught exception:", e);
  });

  process.on("unhandledRejection", (e) => {
    console.error("Unhandled rejection:", e);
  });

  server.listen(config.listen, () => {
    log(
      `AdamsProxy2 listening on :${config.listen} (base_url=${config.base_url}${config.http_proxy ? `, http_proxy=${config.http_proxy}` : ""})`,
    );
    log(
      `models: ${config.models.map((m) => `${m.name}(id=${m.id})`).join(", ")}`,
    );
  });
}

main();
