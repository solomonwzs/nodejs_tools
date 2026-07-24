import fs from "fs";
import http from "http";
import https from "https";
import net from "net";

interface Config {
  listen: number;
  log_file?: string;
}

let config: Config;

function loadConfig(): Config {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: node index.js <config.json>");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function writeLog(entry: Record<string, any>): void {
  if (!config.log_file) return;
  fs.appendFileSync(config.log_file, JSON.stringify(entry) + "\n");
}

function getTargetUrl(req: http.IncomingMessage): string {
  if (req.url && /^https?:\/\//.test(req.url)) {
    return req.url;
  }
  const scheme = "https";
  const host = req.headers.host || "localhost";
  return `${scheme}://${host}${req.url || "/"}`;
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
): Promise<void> {
  const targetUrl = getTargetUrl(req);
  const target = new URL(targetUrl);
  const useHttps = target.protocol === "https:";

  console.log(`${req.method} ${targetUrl}`);

  const ts = Date.now();
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") reqHeaders[k] = v;
  }

  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: target.hostname,
      port: target.port || (useHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers: reqHeaders,
      rejectUnauthorized: false,
    };

    const transport = useHttps ? https : http;

    const proxyReq = transport.request(options, (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);

      {
        // tee: write to client and collect chunks for logging
        proxyRes.on("data", (chunk) => res.write(chunk));
        proxyRes.on("end", () => {
          res.end();
          writeLog({
            ts: new Date(ts).toISOString(),
            method: req.method,
            url: targetUrl,
            req_headers: reqHeaders,
            req_body: body.length > 0 ? body.toString("utf-8") : "",
            status: proxyRes.statusCode,
            res_headers: proxyRes.headers,
            res_body: Buffer.concat(chunks).toString("utf-8"),
          });
          resolve(undefined);
        });
      }
    });

    proxyReq.on("error", (e) => {
      console.error("Proxy error:", e.message);
      writeLog({
        ts: new Date(ts).toISOString(),
        method: req.method,
        url: targetUrl,
        req_headers: reqHeaders,
        req_body: body.length > 0 ? body.toString("utf-8") : "",
        error: e.message,
      });
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

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);

  await proxyRequest(req, res, body);
}

function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
): void {
  const [host, portStr] = (req.url || "").split(":");
  const port = parseInt(portStr) || 443;

  console.log(`CONNECT ${host}:${port}`);

  writeLog({
    ts: new Date().toISOString(),
    method: "CONNECT",
    host,
    port,
  });

  const targetSocket = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });

  targetSocket.on("error", (e) => {
    console.error(`CONNECT error (${host}:${port}):`, e.message);
    clientSocket.end();
  });

  clientSocket.on("error", () => {
    targetSocket.end();
  });
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

  server.on("connect", handleConnect);

  process.on("uncaughtException", (e) => {
    console.error("Uncaught exception:", e);
  });

  process.on("unhandledRejection", (e) => {
    console.error("Unhandled rejection:", e);
  });

  server.listen(config.listen, () => {
    console.log(`Proxy listening on :${config.listen}`);
    if (config.log_file) {
      console.log(`Logging to ${config.log_file}`);
    }
  });
}

main();
