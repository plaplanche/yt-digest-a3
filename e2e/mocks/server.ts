import { createServer } from "node:http";

const port = Number(process.env.MOCKS_PORT ?? "8789");

function send(
  res: import("node:http").ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  console.log(`${req.method} ${url.pathname}`);
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, JSON.stringify({ status: "ok" }), "application/json");
  } else if (req.method === "GET" && url.pathname === "/sponsorblock/api/skipSegments") {
    send(res, 404, "Not Found", "text/plain");
  } else {
    send(res, 404, "Not Found", "text/plain");
  }
});

server.listen(port, "127.0.0.1", () => console.log(`mocks: listening on 127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
