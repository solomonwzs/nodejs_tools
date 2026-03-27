import http from "http";
import fs from "fs";
import path from "path";
import { URL } from "url";
const ALLOWED_FORWARD_HEADERS = ["content-type", "content-length", "authorization"];
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

interface ModelConfig {
  names: string[];
  target: string;
  http_proxy?: string;
  ext_headers?: Record<string, string>;
}

interface Config {
  listen: number;
  models: ModelConfig[];
}

interface ModelInfo {
  id: string;
  [key: string]: any;
}

let config: Config;

function loadConfig(): Config {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const defaultConfigPath = path.join(homeDir, ".config", "adamsproxy.json");
  const configPath = process.argv[2] || defaultConfigPath;
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    console.error(`Failed to load config from ${configPath}:`, e);
    process.exit(1);
  }
}

function findModelConfig(modelName: string): ModelConfig | undefined {
  return config.models.find((m) => m.names.includes(modelName));
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

    const proxyReq = http.request(options, (proxyRes) => {
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

async function fetchModelsFromTarget(
  targetUrl: string,
  httpProxy?: string,
  extHeaders?: Record<string, string>,
): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const basePath = target.pathname.replace(/\/+$/, "");
    const modelsPath = basePath + "/models";

    let proxyTarget = target;
    let proxyPath = modelsPath;

    if (httpProxy) {
      proxyTarget = new URL(httpProxy);
      proxyPath = targetUrl.replace(/\/+$/, "") + "/models";
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

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(data.data || []);
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

  for (const modelConfig of config.models) {
    if (seenTargets.has(modelConfig.target)) {
      continue;
    }
    seenTargets.add(modelConfig.target);

    const models = await fetchModelsFromTarget(
      modelConfig.target,
      modelConfig.http_proxy,
      modelConfig.ext_headers,
    );
    allModels.push(...models);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: allModels }));
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  let bodySize = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    bodySize += buf.length;
    if (bodySize > MAX_BODY_SIZE) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      return;
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);

  let requestBody: any;
  try {
    requestBody = JSON.parse(body.toString());
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const modelName = requestBody.model;
  if (!modelName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing model field" }));
    return;
  }

  const modelConfig = findModelConfig(modelName);
  if (!modelConfig) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Model ${modelName} not found` }));
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Proxying request for model: ${modelName} -> ${modelConfig.target}`,
  );

  await proxyRequest(
    req,
    res,
    modelConfig.target,
    body,
    modelConfig.http_proxy,
    modelConfig.ext_headers,
  );
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const urlPath = req.url || "/";

  if (urlPath === "/$/models_info") {
    await handleModelsInfo(res);
    return;
  }

  if (urlPath === "/v1/chat/completions") {
    await handleChatCompletions(req, res);
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

  server.listen(config.listen, () => {
    console.log(`AdamsProxy server listening on port ${config.listen}`);
    console.log(
      `Configured models: ${config.models.flatMap((m) => m.names).join(", ")}`,
    );
  });
}

main();
