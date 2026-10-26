import http from "node:http";
import httpProxy from "http-proxy";

const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? 3847);
const web = `http://127.0.0.1:${process.env.WEB_INTERNAL_PORT ?? 3846}`;
const api = `http://127.0.0.1:${process.env.API_PORT ?? 3848}`;
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

proxy.on("error", (_err, _req, res) => {
  if (res && "writeHead" in res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("The workplace is still starting.");
  }
});

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const target = url.startsWith("/api") || url.startsWith("/socket.io") ? api : web;
  proxy.web(req, res, { target });
});

server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "/";
  const target = url.startsWith("/socket.io") ? api : web;
  proxy.ws(req, socket, head, { target });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Marlow workplace proxy on http://127.0.0.1:${port}`);
});
