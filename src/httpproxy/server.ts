import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { Config } from "./config.js";

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

function forwardHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const connectionHeaders = new Set(
    String(source.connection || "").split(",").map((name) => name.trim().toLowerCase()),
  );
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (!HOP_HEADERS.has(name) && !connectionHeaders.has(name) && value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

function targetUrl(req: http.IncomingMessage): URL {
  const origin = req.headers["x-ori-host"];
  if (typeof origin !== "string") throw new Error("Missing or invalid X-Ori-Host header");
  const target = new URL(origin);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password ||
      target.pathname !== "/" || target.search || target.hash) {
    throw new Error("X-Ori-Host must be an HTTP(S) origin, e.g. https://www.example.org");
  }
  // Only accept origin-form paths; never let an absolute URL override the origin.
  // Keep the raw request path when forwarding (no URL normalization).
  const path = req.url || "/";
  if (!path.startsWith("/") || path.includes("#")) throw new Error("Request URL must be a path");
  return target;
}

function proxyAuth(proxy: URL): http.OutgoingHttpHeaders {
  if (!proxy.username && !proxy.password) return {};
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function forward(req: http.IncomingMessage, res: http.ServerResponse, config: Config): void {
  let target: URL;
  try {
    target = targetUrl(req);
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid target" }));
    req.resume();
    return;
  }

  const selectedProxy = target.protocol === "https:" ? config.httpsProxy : config.httpProxy;
  const proxy = selectedProxy ? new URL(selectedProxy) : undefined;
  const headers = forwardHeaders(req.headers);
  delete headers["x-ori-host"];
  headers.host = target.host;
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const requestPath = req.url || "/";
  const requestUrl = target.origin + requestPath;
  console.log(`${req.method} ${requestUrl} (${proxy ? "via proxy" : "direct"})`);

  let outgoing: http.ClientRequest | undefined;
  let connectRequest: http.ClientRequest | undefined;
  let upstream: http.IncomingMessage | undefined;
  let tunnel: net.Socket | undefined;
  let secure: tls.TLSSocket | undefined;
  let agent: https.Agent | undefined;
  let done = false;
  const cleanup = () => {
    outgoing?.destroy();
    connectRequest?.destroy();
    upstream?.destroy();
    agent?.destroy();
    secure?.destroy();
    tunnel?.destroy();
  };
  const fail = (error: Error) => {
    if (done) return;
    done = true;
    console.error(`Proxy error for ${target.href}: ${error.message}`);
    cleanup();
    req.unpipe();
    req.resume();
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Bad Gateway" }));
    } else {
      res.destroy(error);
    }
  };
  res.once("close", () => {
    done = true;
    cleanup();
  });
  req.once("aborted", () => fail(new Error("Client aborted request")));
  req.once("error", fail);

  const receive = (response: http.IncomingMessage) => {
    upstream = response;
    if (done) { response.destroy(); return; }
    res.writeHead(response.statusCode || 502, response.statusMessage, forwardHeaders(response.headers));
    response.once("error", fail);
    response.once("aborted", () => fail(new Error("Upstream aborted response")));
    response.pipe(res);
  };
  const send = (transport: typeof http | typeof https, options: http.RequestOptions) => {
    if (done) return;
    outgoing = transport.request(options, receive);
    outgoing.once("error", fail);
    req.pipe(outgoing);
  };

  try {
    if (proxy && target.protocol === "https:") {
      // HTTPS upstreams require a CONNECT tunnel followed by a verified TLS session.
      const transport = proxy.protocol === "https:" ? https : http;
      const authority = `${target.hostname}:${port}`;
      connectRequest = transport.request({
        hostname: hostname(proxy),
        port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: authority,
        headers: { host: authority, ...proxyAuth(proxy) },
      });
      connectRequest.setTimeout(30_000, () => fail(new Error("Proxy CONNECT timed out")));
      connectRequest.once("error", fail);
      connectRequest.once("connect", (response, socket, head) => {
        tunnel = socket;
        if (done) { socket.destroy(); return; }
        connectRequest?.setTimeout(0);
        if (response.statusCode !== 200) {
          fail(new Error(`Proxy CONNECT returned ${response.statusCode}`));
          return;
        }
        socket.once("error", fail);
        if (head.length) socket.unshift(head);
        secure = tls.connect({
          socket,
          ...(net.isIP(hostname(target)) ? {} : { servername: hostname(target) }),
          // Verify the target identity even for IP addresses without SNI.
          checkServerIdentity: (_host, cert) => tls.checkServerIdentity(hostname(target), cert),
        });
        secure.setTimeout(30_000, () => fail(new Error("TLS handshake timed out")));
        secure.once("error", fail);
        secure.once("secureConnect", () => {
          secure?.setTimeout(0);
          agent = new https.Agent({ keepAlive: false });
          agent.createConnection = () => secure!;
          send(https, {
            hostname: hostname(target), port, method: req.method,
            path: requestPath, headers, agent,
          });
        });
      });
      connectRequest.end();
    } else {
      const destination = proxy || target;
      send(destination.protocol === "https:" ? https : http, {
        hostname: hostname(destination),
        port: destination.port || (destination.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: proxy ? requestUrl : requestPath,
        headers: { ...headers, ...(proxy ? proxyAuth(proxy) : {}) },
      });
    }
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }
}

export function createProxyServer(config: Config): http.Server {
  const server = http.createServer((req, res) => forward(req, res, config));
  // This is a header-routed HTTP service, not a client-facing CONNECT proxy.
  server.on("connect", (_req, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}
