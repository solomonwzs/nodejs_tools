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

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function debug(msg: string): void {
  if (process.env.DEBUG) {
    log(`[debug] ${msg}`);
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
  https_proxy?: string;
  ext_headers?: Record<string, string>;
  models: ModelConfig[];
}

let config: Config;

function validateProxyUrl(proxyUrl: string | undefined, fieldName: string): void {
  if (!proxyUrl) return;

  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http: or https:`);
  }
}

function loadConfig(): Config {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const defaultConfigPath = path.join(homeDir, ".config", "adamsproxy2.json");
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

function findModelConfig(modelName: string): ModelConfig | undefined {
  return config.models.find((model) => model.name === modelName);
}

function composeTargetUrl(model: ModelConfig): string {
  return `${config.base_url.replace(/\/+$/, "")}/service/${model.id}`;
}

function selectProxy(target: URL): string | undefined {
  return target.protocol === "https:" ? config.https_proxy : config.http_proxy;
}

interface UpstreamRequest {
  url: string;
  method: string;
  headers: http.OutgoingHttpHeaders;
  body?: Buffer;
}

async function requestUpstream(
  request: UpstreamRequest,
  handleResponse: (response: http.IncomingMessage) => Promise<void>,
): Promise<void> {
  const target = new URL(request.url);
  const selectedProxyUrl = selectProxy(target);
  const proxyTarget = selectedProxyUrl ? new URL(selectedProxyUrl) : target;
  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const usesTunnel = Boolean(selectedProxyUrl && target.protocol === "https:");
  const proxyTransport = proxyTarget.protocol === "https:" ? https : http;

  debug(
    `>> ${request.method} ${request.url} (${selectedProxyUrl ? `via ${selectedProxyUrl}` : "direct"})`,
  );

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
      reject(error);
    };
    const consumeResponse = (response: http.IncomingMessage) => {
      handleResponse(response).then(complete, fail);
    };
    const writeRequest = (clientRequest: http.ClientRequest) => {
      clientRequest.once("error", fail);
      if (request.body && request.body.length > 0) {
        clientRequest.write(request.body);
      }
      clientRequest.end();
    };

    if (usesTunnel) {
      const connectReq = proxyTransport.request({
        hostname: proxyTarget.hostname,
        port: proxyTarget.port || (proxyTarget.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: `${target.hostname}:${targetPort}`,
        headers: { host: `${target.hostname}:${targetPort}` },
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
          const clientRequest = https.request(
            {
              hostname: target.hostname,
              port: targetPort,
              path: target.pathname + target.search,
              method: request.method,
              headers: request.headers,
              agent: tunnelAgent,
            },
            consumeResponse,
          );
          writeRequest(clientRequest);
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
    const clientRequest = transport.request(
      {
        hostname: proxyTarget.hostname,
        port: proxyTarget.port || (proxyTarget.protocol === "https:" ? 443 : 80),
        path: selectedProxyUrl ? request.url : target.pathname + target.search,
        method: request.method,
        headers: request.headers,
      },
      consumeResponse,
    );
    writeRequest(clientRequest);
  });
}

function forwardedHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of ALLOWED_FORWARD_HEADERS) {
    const value = req.headers[key];
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer,
  extHeaders?: Record<string, string>,
): Promise<void> {
  const target = new URL(targetUrl);
  await requestUpstream(
    {
      url: targetUrl,
      method: req.method || "POST",
      headers: {
        ...forwardedHeaders(req),
        host: target.host,
        ...extHeaders,
      },
      body,
    },
    (proxyRes) => new Promise((resolve, reject) => {
      debug(`<< ${proxyRes.statusCode || 502} ${targetUrl}`);
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      res.once("finish", resolve);
      res.once("close", resolve);
      proxyRes.once("error", reject);
      proxyRes.pipe(res);
    }),
  ).catch((error: Error) => {
    console.error("Proxy request error:", error);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad Gateway" }));
    } else if (!res.writableEnded && !res.destroyed) {
      res.destroy(error);
    }
    throw error;
  });
}

async function handleProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  let bodySize = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bodySize += buffer.length;
    if (bodySize > MAX_BODY_SIZE) {
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
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (typeof requestBody.model !== "string" || requestBody.model.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing model field" }));
    return;
  }

  const model = findModelConfig(requestBody.model);
  if (!model) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Model ${requestBody.model} not found` }));
    return;
  }

  const targetUrl = composeTargetUrl(model) + (req.url || "/");
  log(`model=${requestBody.model} id=${model.id} -> ${targetUrl}`);
  await proxyRequest(req, res, targetUrl, body, config.ext_headers);
}

interface ModelInfo {
  id: string;
  [key: string]: unknown;
}

async function fetchModelsFromTarget(
  targetUrl: string,
  extHeaders?: Record<string, string>,
): Promise<ModelInfo[]> {
  const modelsUrl = `${targetUrl.replace(/\/+$/, "")}/v1/models`;
  const target = new URL(modelsUrl);

  try {
    let models: ModelInfo[] = [];
    await requestUpstream(
      {
        url: modelsUrl,
        method: "GET",
        headers: { host: target.host, ...extHeaders },
      },
      (response) => new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString()) as { data?: ModelInfo[] };
            models = data.data || [];
            debug(`<< ${response.statusCode || 502} ${modelsUrl} (${models.length} models)`);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }),
    );
    return models;
  } catch (error) {
    console.error(`Failed to fetch models from ${targetUrl}:`, error);
    return [];
  }
}

async function handleModelsInfo(res: http.ServerResponse): Promise<void> {
  const allModels: ModelInfo[] = [];
  const seenTargets = new Set<string>();

  for (const model of config.models) {
    const targetUrl = composeTargetUrl(model);
    if (seenTargets.has(targetUrl)) {
      continue;
    }
    seenTargets.add(targetUrl);

    const models = await fetchModelsFromTarget(targetUrl, config.ext_headers);
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
  const urlPath = new URL(req.url || "/", "http://localhost").pathname;

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

function main(): void {
  config = loadConfig();

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      console.error("Request handling error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    }
  });

  server.on("error", (error) => {
    console.error("Server error:", error);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
  });

  process.on("unhandledRejection", (error) => {
    console.error("Unhandled rejection:", error);
  });

  server.listen(config.listen, () => {
    log(
      `AdamsProxy2 listening on :${config.listen} (base_url=${config.base_url}${config.http_proxy ? `, http_proxy=${config.http_proxy}` : ""}${config.https_proxy ? `, https_proxy=${config.https_proxy}` : ""})`,
    );
    log(`models: ${config.models.map((model) => `${model.name}(id=${model.id})`).join(", ")}`);
  });
}

main();
