import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { OutboundRequest, ProxySettings } from "./types.js";

const ALLOWED_LLM_HEADERS = [
  "content-type",
  "content-length",
  "authorization",
];
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function selectProxy(target: URL, settings: ProxySettings): string | undefined {
  return target.protocol === "https:" ? settings.httpsProxy : settings.httpProxy;
}

export async function requestUpstream(
  request: OutboundRequest,
  consumeResponse: (response: http.IncomingMessage) => Promise<void>,
): Promise<void> {
  const target = new URL(request.url);
  const selectedProxyUrl = selectProxy(target, request);
  const proxyTarget = selectedProxyUrl ? new URL(selectedProxyUrl) : target;
  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const usesTunnel = Boolean(selectedProxyUrl && target.protocol === "https:");
  const proxyTransport = proxyTarget.protocol === "https:" ? https : http;

  if (process.env.DEBUG) {
    console.log(
      `[${new Date().toISOString()}] [debug] ${request.method} ${request.url} (${selectedProxyUrl ? `via ${selectedProxyUrl}` : "direct"})`,
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let tunnelSocket: net.Socket | undefined;
    let secureSocket: tls.TLSSocket | undefined;
    let tunnelAgent: https.Agent | undefined;

    const cleanup = () => {
      tunnelAgent?.destroy();
      secureSocket?.destroy();
      if (tunnelSocket && !tunnelSocket.destroyed) tunnelSocket.destroy();
    };
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleResponse = (response: http.IncomingMessage) => {
      Promise.resolve()
        .then(() => consumeResponse(response))
        .then(complete, fail);
    };
    const send = (clientRequest: http.ClientRequest) => {
      clientRequest.once("error", fail);
      if (request.body && request.body.length > 0) clientRequest.write(request.body);
      clientRequest.end();
    };

    if (usesTunnel) {
      const connectRequest = proxyTransport.request({
        hostname: proxyTarget.hostname,
        port: proxyTarget.port || (proxyTarget.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: `${target.hostname}:${targetPort}`,
        headers: { host: `${target.hostname}:${targetPort}` },
      });
      connectRequest.once("connect", (connectResponse, socket, head) => {
        tunnelSocket = socket;
        if (connectResponse.statusCode !== 200) {
          fail(new Error(`Proxy CONNECT failed with status ${connectResponse.statusCode}`));
          return;
        }
        if (head.length > 0) socket.unshift(head);

        secureSocket = tls.connect({
          socket,
          ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
        });
        secureSocket.once("error", fail);
        secureSocket.once("secureConnect", () => {
          if (!secureSocket) return;
          tunnelAgent = new https.Agent({ keepAlive: false });
          tunnelAgent.createConnection = () => secureSocket!;
          send(https.request({
            hostname: target.hostname,
            port: targetPort,
            path: target.pathname + target.search,
            method: request.method,
            headers: request.headers,
            agent: tunnelAgent,
          }, handleResponse));
        });
      });
      connectRequest.once("error", fail);
      connectRequest.end();
      return;
    }

    const transport = selectedProxyUrl
      ? proxyTransport
      : target.protocol === "https:"
        ? https
        : http;
    send(transport.request({
      hostname: proxyTarget.hostname,
      port: proxyTarget.port || (proxyTarget.protocol === "https:" ? 443 : 80),
      path: selectedProxyUrl ? request.url : target.pathname + target.search,
      method: request.method,
      headers: request.headers,
    }, handleResponse));
  });
}

export function allowlistedHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ALLOWED_LLM_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

export function commonHeaders(
  req: http.IncomingMessage,
  target: URL,
): http.OutgoingHttpHeaders {
  const connectionHeaders = new Set(
    String(req.headers.connection || "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(lowerName) && !connectionHeaders.has(lowerName)) {
      headers[name] = value;
    }
  }
  headers.host = target.host;
  return headers;
}

export async function pipeResponse(
  response: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    res.writeHead(response.statusCode || 502, response.headers);
    res.once("finish", resolve);
    res.once("close", () => {
      if (!res.writableEnded) response.destroy();
      resolve();
    });
    response.once("error", reject);
    response.pipe(res);
  });
}
