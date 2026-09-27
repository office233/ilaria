const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConnectorHub } = require("./connectors.cjs");
const { createAuthorization } = require("./oauth.cjs");
// Test-only vault. Production always uses Electron safeStorage / Windows DPAPI.
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text).map((byte) => byte ^ 0x5a),
  decryptString: (bytes) =>
    Buffer.from(bytes)
      .map((byte) => byte ^ 0x5a)
      .toString(),
};
test("MCP initialize, paginated discovery, invocation, reconnect and removal", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "swypik-connector-test-"),
  );
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    calls.push(message.method);
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    if (message.method === "tools/list")
      result = message.params?.cursor
        ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
        : {
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
            nextCursor: "next",
          };
    if (message.method === "tools/call")
      result = {
        content: [{ type: "text", text: message.params.arguments.text }],
      };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const hub = new ConnectorHub(directory, storage);
  const config = {
    id: "fixture",
    name: "Fixture",
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    token: "test-token",
    authentication: "token",
  };
  const result = await hub.connect(config);
  assert.equal(result.tools, 2);
  assert.equal(JSON.stringify(hub.list()).includes("test-token"), false);
  assert.equal(
    fs.readFileSync(hub.file).includes(Buffer.from("test-token")),
    false,
  );
  assert.equal(
    (
      await hub.call({
        id: "fixture",
        name: "echo",
        arguments: { text: "works" },
      })
    ).content[0].text,
    "works",
  );
  await assert.rejects(
    hub.call({ id: "fixture", name: "not-listed", arguments: {} }),
    /Unknown/,
  );
  await assert.rejects(
    hub.connect({ id: "bad", url: "file:///private" }),
    /HTTPS/,
  );
  const restored = new ConnectorHub(directory, storage);
  assert.equal(restored.list()[0].connected, false);
  await hub.disconnect("fixture");
  assert.deepEqual(hub.list(), []);
  assert(calls.includes("notifications/initialized"));
});
test("OAuth loopback rejects missing state and accepts the bound callback only", async () => {
  const flow = await createAuthorization({});
  try {
    assert.equal(
      (await fetch(flow.provider.redirectUrl + "?code=fake")).status,
      400,
    );
    const state = flow.provider.state();
    assert.equal(
      (
        await fetch(
          flow.provider.redirectUrl + "?code=fixture-code&state=" + state,
        )
      ).status,
      200,
    );
    assert.equal(await flow.code, "fixture-code");
  } finally {
    flow.close();
  }
});
