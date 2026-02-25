import http from "http";
import fs from "fs";
import { URL } from "url";
import { Readable } from "stream";

interface ModelConfig {
  name: string;
  target: string;
  http_proxy?: string;
  ext_headers?: Record<string, string>;
}

interface Config {
  listen: number;
  models: ModelConfig[];
}

let config: Config;

function loadConfig(): Config {
  const configPath = process.argv[2] || "config.json";
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    console.error(`Failed to load config from ${configPath}:`, e);
    process.exit(1);
  }
}

function findModelConfig(modelName: string): ModelConfig | undefined {
  return config.models.find((m) => m.name === modelName);
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  httpProxy?: string,
  extHeaders?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const target = new URL(targetUrl);
      const path = req.url || "/";

      let proxyTarget = target;
      let proxyPath = path;

      if (httpProxy) {
        proxyTarget = new URL(httpProxy);
        proxyPath = targetUrl + path;
      }

      const options: http.RequestOptions = {
        hostname: proxyTarget.hostname,
        port: proxyTarget.port,
        path: proxyPath,
        method: req.method,
        headers: {
          ...req.headers,
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
        res.writeHead(502);
        res.end(JSON.stringify({ error: "Bad Gateway" }));
        reject(e);
      });

      proxyReq.write(body);
      proxyReq.end();
    });
    req.on("error", reject);
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }

  let requestBody: any;
  try {
    requestBody = JSON.parse(body);
  } catch (e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const modelName = requestBody.model;
  if (!modelName) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Missing model field" }));
    return;
  }

  const modelConfig = findModelConfig(modelName);
  if (!modelConfig) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: `Model ${modelName} not found` }));
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Proxying request for model: ${modelName} -> ${modelConfig.target}`,
  );

  // Re-create request with body for proxyRequest
  const mockReq = new Readable() as unknown as http.IncomingMessage;
  mockReq.push(body);
  mockReq.push(null);
  Object.assign(mockReq, {
    method: req.method,
    url: req.url,
    headers: req.headers,
  });

  await proxyRequest(
    mockReq,
    res,
    modelConfig.target,
    modelConfig.http_proxy,
    modelConfig.ext_headers,
  );
}

function main() {
  config = loadConfig();

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      console.error("Request handling error:", e);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  });

  server.listen(config.listen, () => {
    console.log(`AdamsProxy server listening on port ${config.listen}`);
    console.log(
      `Configured models: ${config.models.map((m) => m.name).join(", ")}`,
    );
  });
}

main();
