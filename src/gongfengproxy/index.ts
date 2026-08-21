import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import path from "path";
import tls from "tls";

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
  https_proxy?: string;
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
    const parsed: Config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    validateProxyUrl(parsed.http_proxy, "http_proxy");
    validateProxyUrl(parsed.https_proxy, "https_proxy");
    log(`Loaded config from ${configPath}`);
    return parsed;
  } catch (e) {
    console.error(`Failed to load config from ${configPath}:`, e);
    process.exit(1);
  }
}

function validateProxyUrl(
  proxyUrl: string | undefined,
  fieldName: string,
): void {
  if (!proxyUrl) return;

  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http: or https:`);
  }
}

function findModelConfig(modelId: string): ModelConfig | undefined {
  return config.models.find((model) => model.id === modelId);
}

function composeTargetUrl(req: http.IncomingMessage): string {
  return config.baseUrl.replace(/\/+$/, "") + (req.url || "/");
}

function forwardResponse(
  proxyRes: http.IncomingMessage,
  res: http.ServerResponse,
  resolve: () => void,
  reject: (error: Error) => void,
): void {
  res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
  res.once("finish", resolve);
  res.once("close", resolve);
  proxyRes.once("error", reject);
  proxyRes.pipe(res);
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer,
  model: ModelConfig,
): Promise<void> {
  const target = new URL(targetUrl);
  const selectedProxyUrl = target.protocol === "https:"
    ? config.https_proxy
    : config.http_proxy;
  const proxyTarget = selectedProxyUrl ? new URL(selectedProxyUrl) : target;
  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const usesTunnel = Boolean(selectedProxyUrl && target.protocol === "https:");
  const proxyPath = selectedProxyUrl && !usesTunnel
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

  const proxyTransport = proxyTarget.protocol === "https:" ? https : http;

  log(
    `model=${model.id} ${req.method} ${req.url} -> ${targetUrl} (${selectedProxyUrl ? `via ${selectedProxyUrl}` : "direct"})`,
  );
  debug(`forwarded headers: ${Object.keys(forwardedHeaders).join(", ") || "none"}; model headers: ${Object.keys(model.headers || {}).join(", ") || "none"}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let tunnelSocket: net.Socket | undefined;
    let tlsSocket: tls.TLSSocket | undefined;
    let tunnelAgent: https.Agent | undefined;

    const cleanupTunnel = () => {
      tunnelAgent?.destroy();
      tlsSocket?.destroy();
      if (tunnelSocket && !tunnelSocket.destroyed) {
        tunnelSocket.destroy();
      }
    };
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanupTunnel();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupTunnel();
      console.error("Proxy request error:", error);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway" }));
      } else if (!res.writableEnded && !res.destroyed) {
        res.destroy(error);
      }
      reject(error);
    };
    const handleResponse = (proxyRes: http.IncomingMessage) => {
      log(`model=${model.id} <- ${proxyRes.statusCode || 502} ${targetUrl}`);
      forwardResponse(proxyRes, res, complete, fail);
    };
    const writeRequest = (proxyReq: http.ClientRequest) => {
      proxyReq.once("error", fail);
      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    };

    if (usesTunnel) {
      const connectReq = proxyTransport.request({
        hostname: proxyTarget.hostname,
        port: proxyTarget.port || (proxyTarget.protocol === "https:" ? 443 : 80),
        path: `${target.hostname}:${targetPort}`,
        method: "CONNECT",
        headers: {
          host: `${target.hostname}:${targetPort}`,
        },
      });

      connectReq.once("connect", (connectRes, socket, head) => {
        tunnelSocket = socket;
        if (connectRes.statusCode !== 200) {
          fail(new Error(`Proxy CONNECT failed with status ${connectRes.statusCode}`));
          return;
        }

        if (head.length > 0) {
          socket.unshift(head);
        }

        tlsSocket = tls.connect({
          socket,
          ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
        });
        tlsSocket.once("error", fail);
        tlsSocket.once("secureConnect", () => {
          if (!tlsSocket) return;

          tunnelAgent = new https.Agent({ keepAlive: false });
          tunnelAgent.createConnection = () => tlsSocket!;

          const proxyReq = https.request(
            {
              hostname: target.hostname,
              port: targetPort,
              path: target.pathname + target.search,
              method: req.method,
              headers,
              agent: tunnelAgent,
            },
            handleResponse,
          );
          writeRequest(proxyReq);
        });
      });
      connectReq.once("error", fail);
      connectReq.end();
      return;
    }

    const transport = selectedProxyUrl
      ? proxyTransport
      : target.protocol === "https:"
        ? https
        : http;
    const proxyReq = transport.request(
      {
        hostname: proxyTarget.hostname,
        port: proxyTarget.port || (proxyTarget.protocol === "https:" ? 443 : 80),
        path: proxyPath,
        method: req.method,
        headers,
      },
      handleResponse,
    );
    writeRequest(proxyReq);
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
      `GongfengProxy listening on :${config.port} (baseUrl=${config.baseUrl}${config.http_proxy ? `, http_proxy=${config.http_proxy}` : ""}${config.https_proxy ? `, https_proxy=${config.https_proxy}` : ""})`,
    );
    log(`models: ${config.models.map((model) => model.id).join(", ")}`);
  });
}

main();
