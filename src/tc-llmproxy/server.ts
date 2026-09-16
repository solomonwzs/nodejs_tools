import http from "http";
import os from "os";
import { AdamsRegistry } from "./adams.js";
import { generatePiModels } from "./pi-models.js";
import {
  allowlistedHeaders,
  commonHeaders,
  pipeResponse,
  requestUpstream,
} from "./transport.js";
import {
  AdamsProxyConfig,
  CommonProxyConfig,
  Config,
  GongfengProxyConfig,
  HttpError,
  OutboundRequest,
} from "./types.js";

const MAX_BODY_SIZE = 10 * 1024 * 1024;

function joinUrl(baseUrl: string, requestPath: string): string {
  return baseUrl.replace(/\/+$/, "") + (requestPath.startsWith("/") ? requestPath : `/${requestPath}`);
}

async function readModelBody(
  req: http.IncomingMessage,
): Promise<{ body: Buffer; model: string }> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_SIZE) {
    throw new HttpError(413, "Payload Too Large");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_SIZE) throw new HttpError(413, "Payload Too Large");
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).model !== "string" ||
    ((parsed as Record<string, unknown>).model as string).length === 0
  ) {
    throw new HttpError(400, "Missing model field");
  }

  return { body, model: (parsed as Record<string, unknown>).model as string };
}

async function readImageBody(
  req: http.IncomingMessage,
): Promise<{ body: Buffer; model: string }> {
  const request = await readModelBody(req);
  const parsed = JSON.parse(request.body.toString()) as Record<string, unknown>;
  if (typeof parsed.prompt !== "string" || parsed.prompt.length === 0) {
    throw new HttpError(400, "Missing prompt field");
  }
  return request;
}

function gongfengImageHeaders(
  config: GongfengProxyConfig,
  target: URL,
  model?: string,
  body?: Buffer,
): http.OutgoingHttpHeaders {
  return {
    accept: "application/json",
    host: target.host,
    "X-Username": config.username,
    "DEVICE-ID": config.deviceId,
    "OAUTH-TOKEN": config.authToken,
    "x-platform": `${os.type()}/${os.machine()}`,
    "x-user-agent": "gen-image.sh",
    ...(model ? { "X-Model-Name": model } : {}),
    ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}),
  };
}

async function forwardToClient(
  res: http.ServerResponse,
  outbound: OutboundRequest,
  context: string,
): Promise<void> {
  const requestSize = outbound.body?.length ?? 0;
  console.log(
    `[${new Date().toISOString()}] ${context} ${outbound.method} target=${outbound.url} request_size=${requestSize}`,
  );
  try {
    await requestUpstream(outbound, (response) => {
      console.log(
        `[${new Date().toISOString()}] ${context} upstream_status=${response.statusCode || 502} target=${outbound.url}`,
      );
      return pipeResponse(response, res);
    });
  } catch (error) {
    console.error(`Upstream request failed for ${outbound.url}:`, error);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "Bad Gateway" });
    } else if (!res.writableEnded && !res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
}

async function handleAdams(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  config: AdamsProxyConfig,
  adamsRegistry: AdamsRegistry,
): Promise<void> {
  const upstreamPath = parsedUrl.pathname.slice("/adams".length) + parsedUrl.search;
  const pathname = parsedUrl.pathname.slice("/adams".length);
  if (pathname !== "/v1/chat/completions" && pathname !== "/v1/messages") {
    throw new HttpError(404, "Not Found");
  }
  if (!adamsRegistry.available) {
    throw new HttpError(503, "Adams service unavailable");
  }

  const { body, model } = await readModelBody(req);
  const serviceTarget = adamsRegistry.findTarget(model);
  if (!serviceTarget) throw new HttpError(404, `Adams model ${model} not found`);
  const targetUrl = joinUrl(serviceTarget, upstreamPath);
  const target = new URL(targetUrl);

  await forwardToClient(res, {
    url: targetUrl,
    method: req.method || "POST",
    headers: {
      ...allowlistedHeaders(req),
      host: target.host,
      ...config.extHeaders,
    },
    body,
    httpProxy: config.httpProxy,
    httpsProxy: config.httpsProxy,
  }, `provider=adams model=${model}`);
}

async function handleGongfeng(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  config: GongfengProxyConfig,
): Promise<void> {
  const pathname = parsedUrl.pathname.slice("/gongfeng".length);
  if (pathname !== "/v1/chat/completions") {
    throw new HttpError(404, "Not Found");
  }

  const { body, model: modelId } = await readModelBody(req);
  const model = config.models.find((item) => item.id === modelId);
  if (!model) throw new HttpError(404, `Gongfeng model ${modelId} not found`);
  const targetUrl = joinUrl(config.baseUrl, pathname + parsedUrl.search);
  const target = new URL(targetUrl);

  await forwardToClient(res, {
    url: targetUrl,
    method: req.method || "POST",
    headers: {
      ...allowlistedHeaders(req),
      host: target.host,
      ...model.headers,
      "X-Username": config.username,
      "DEVICE-ID": config.deviceId,
      "OAUTH-TOKEN": config.authToken,
    },
    body,
    httpProxy: config.httpProxy,
    httpsProxy: config.httpsProxy,
  }, `provider=gongfeng model=${modelId}`);
}

async function handleImageModelList(
  res: http.ServerResponse,
  config: GongfengProxyConfig,
): Promise<void> {
  const targetUrl = joinUrl(config.baseUrl, "/v1/image-model-configs");
  const target = new URL(targetUrl);
  await forwardToClient(res, {
    url: targetUrl,
    method: "GET",
    headers: gongfengImageHeaders(config, target),
    httpProxy: config.httpProxy,
    httpsProxy: config.httpsProxy,
  }, "provider=gongfeng-image models");
}

async function handleImageGeneration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: GongfengProxyConfig,
): Promise<void> {
  const { body, model } = await readImageBody(req);
  const targetUrl = joinUrl(config.baseUrl, "/v1/images/generations");
  const target = new URL(targetUrl);
  await forwardToClient(res, {
    url: targetUrl,
    method: "POST",
    headers: gongfengImageHeaders(config, target, model, body),
    body,
    httpProxy: config.httpProxy,
    httpsProxy: config.httpsProxy,
  }, `provider=gongfeng-image model=${model}`);
}

async function handleCommon(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  providers: CommonProxyConfig[],
): Promise<void> {
  const match = /^\/comm\/([^/]+)(\/.*)$/.exec(parsedUrl.pathname);
  if (!match) throw new HttpError(404, "Not Found");

  let providerName: string;
  try {
    providerName = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(404, "Not Found");
  }
  const provider = providers.find((item) => item.name === providerName);
  if (!provider) throw new HttpError(404, `Common provider ${providerName} not found`);

  const { body, model } = await readModelBody(req);
  if (!provider.models.some((item) => item.id === model)) {
    throw new HttpError(404, `Model ${model} not found in provider ${providerName}`);
  }

  const targetUrl = joinUrl(provider.baseUrl, match[2] + parsedUrl.search);
  const target = new URL(targetUrl);
  await forwardToClient(res, {
    url: targetUrl,
    method: req.method || "POST",
    headers: commonHeaders(req, target),
    body,
    httpProxy: provider.httpProxy,
    httpsProxy: provider.httpsProxy,
  }, `provider=comm/${providerName} model=${model}`);
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
  adamsRegistry?: AdamsRegistry,
): Promise<void> {
  const parsedUrl = new URL(req.url || "/", "http://localhost");
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  if (parsedUrl.pathname === "/cmd/gen-pi-models-json") {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "GET" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }
    await adamsRegistry?.refresh();
    sendJson(res, 200, generatePiModels(config, adamsRegistry));
    return;
  }
  if (parsedUrl.pathname === "/cmd/list-gen-image-models") {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "GET" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }
    if (!config.gongfengProxy) throw new HttpError(404, "Not Found");
    await handleImageModelList(res, config.gongfengProxy);
    return;
  }
  if (parsedUrl.pathname === "/cmd/gen-image") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }
    if (!config.gongfengProxy) throw new HttpError(404, "Not Found");
    await handleImageGeneration(req, res, config.gongfengProxy);
    return;
  }
  if (parsedUrl.pathname.startsWith("/adams/")) {
    if (!config.adamsProxy || !adamsRegistry) throw new HttpError(404, "Not Found");
    await handleAdams(req, res, parsedUrl, config.adamsProxy, adamsRegistry);
    return;
  }
  if (parsedUrl.pathname.startsWith("/gongfeng/")) {
    if (!config.gongfengProxy) throw new HttpError(404, "Not Found");
    await handleGongfeng(req, res, parsedUrl, config.gongfengProxy);
    return;
  }
  if (parsedUrl.pathname.startsWith("/comm/")) {
    if (!config.commProxy) throw new HttpError(404, "Not Found");
    await handleCommon(req, res, parsedUrl, config.commProxy);
    return;
  }
  throw new HttpError(404, "Not Found");
}

export function createServer(
  config: Config,
  adamsRegistry?: AdamsRegistry,
): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, config, adamsRegistry);
    } catch (error) {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendJson(res, error.statusCode, { error: error.message });
        return;
      }
      console.error("Request handling error:", error);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal Server Error" });
    }
  });
  server.on("error", (error) => console.error("Server error:", error));
  return server;
}
