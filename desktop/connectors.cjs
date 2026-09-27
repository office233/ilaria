const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { safeURL } = require("./policy.cjs");

// The vault is owned by this desktop, never imported from ChatGPT or Codex.
class ConnectorHub {
  constructor(directory, storage) {
    this.storage = storage || require("electron").safeStorage;
    this.file = path.join(directory, "connectors.vault");
    this.active = new Map();
    this.pending = new Set();
    this.saved = Object.create(null);
    if (fs.existsSync(this.file)) {
      if (!this.storage.isEncryptionAvailable())
        throw new Error("OS credential encryption unavailable.");
      this.saved = Object.assign(
        Object.create(null),
        JSON.parse(this.storage.decryptString(fs.readFileSync(this.file))),
      );
    }
  }
  persist() {
    if (!this.storage.isEncryptionAvailable())
      throw new Error("OS credential encryption unavailable.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp";
    fs.writeFileSync(
      temp,
      this.storage.encryptString(JSON.stringify(this.saved)),
      { mode: 0o600 },
    );
    fs.renameSync(temp, this.file);
  }
  list() {
    return Object.entries(this.saved).map(([id, c]) => ({
      id,
      name: c.name,
      url: c.url,
      connected: this.active.has(id),
      authentication: c.oauth ? "oauth" : c.token ? "token" : "none",
    }));
  }
  async connect(config) {
    if (!config || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.id))
      throw new Error("Invalid connector ID");
    if (this.pending.has(config.id))
      throw new Error("Connection already in progress");
    const previous = this.saved[config.id];
    const url = config.url || previous?.url;
    if (!safeURL(url) || new URL(url).hash || new URL(url).search)
      throw new Error(
        "Use an HTTPS MCP endpoint or a local HTTP endpoint, without query credentials.",
      );
    const sameEndpoint = previous?.url === url;
    const entry = {
      name: String(config.name || previous?.name || config.id).slice(0, 100),
      url,
      token:
        config.authentication === "none"
          ? ""
          : config.token || (sameEndpoint ? previous?.token : "") || "",
      oauth:
        config.authentication === "oauth" ||
        (config.authentication === undefined &&
          sameEndpoint &&
          previous?.oauth),
      credentials: sameEndpoint
        ? structuredClone(previous?.credentials || {})
        : {},
    };
    if (entry.oauth) entry.token = "";
    if (entry.token.length > 16384 || /[\r\n]/.test(entry.token))
      throw new Error("Invalid access token");
    this.pending.add(config.id);
    let client, transport, authorization;
    try {
      if (entry.oauth) {
        const { createAuthorization } = require("./oauth.cjs");
        authorization = await createAuthorization(entry.credentials, () => {
          if (this.saved[config.id]?.credentials === entry.credentials)
            this.persist();
        });
      }
      const options = {
        requestInit: {
          headers: entry.token
            ? { Authorization: `Bearer ${entry.token}` }
            : {},
        },
        authProvider: authorization?.provider,
        fetch: (url, options) => {
          if (!safeURL(String(url)))
            throw new Error("Invalid connector request URL");
          return fetch(url, {
            ...options,
            redirect: "error",
            signal: options?.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
              : AbortSignal.timeout(30000),
          });
        },
      };
      const makeClient = () =>
        new Client(
          { name: "SwypikOS", version: "0.1.0" },
          { capabilities: {} },
        );
      client = makeClient();
      transport = new StreamableHTTPClientTransport(new URL(url), options);
      try {
        await client.connect(transport);
      } catch (error) {
        if (!authorization?.started()) throw error;
        const code = await authorization.code;
        await transport.finishAuth(code);
        await client.close();
        client = makeClient();
        transport = new StreamableHTTPClientTransport(new URL(url), options);
        await client.connect(transport);
      }
      const tools = await this.readTools(client);
      const old = this.active.get(config.id);
      this.saved[config.id] = entry;
      try {
        this.persist();
      } catch (error) {
        if (previous) this.saved[config.id] = previous;
        else delete this.saved[config.id];
        throw error;
      }
      this.active.set(config.id, { client, tools });
      if (old) await old.client.close().catch(() => {});
      client.onclose = () => {
        if (this.active.get(config.id)?.client === client)
          this.active.delete(config.id);
      };
      return { id: config.id, tools: tools.length, connected: true };
    } catch (error) {
      await client?.close().catch(() => {});
      throw new Error(
        entry.token
          ? "Connection failed. Check the endpoint, token and permissions."
          : error.message,
      );
    } finally {
      authorization?.close();
      this.pending.delete(config.id);
    }
  }
  async readTools(client) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 15000,
      });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error("Tool catalog exceeds the supported size");
  }
  async tools(id) {
    const connection = this.active.get(id);
    if (!connection) throw new Error("Connect this service first");
    connection.tools = await this.readTools(connection.client);
    return connection.tools;
  }
  async call(request) {
    const connection = this.active.get(request.id);
    if (!connection || !connection.tools.some((t) => t.name === request.name))
      throw new Error("Unknown connected tool");
    if (
      !request.arguments ||
      typeof request.arguments !== "object" ||
      Array.isArray(request.arguments)
    )
      throw new Error("Tool arguments must be an object");
    return connection.client.callTool(
      { name: request.name, arguments: request.arguments },
      undefined,
      { timeout: 60000 },
    );
  }
  async disconnect(id) {
    if (this.pending.has(id))
      throw new Error("Wait for the connection to finish");
    await this.active.get(id)?.client.close();
    this.active.delete(id);
    delete this.saved[id];
    this.persist();
    return { disconnected: true };
  }
}
module.exports = { ConnectorHub };
