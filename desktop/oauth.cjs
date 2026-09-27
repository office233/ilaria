const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { safeURL } = require("./policy.cjs");
async function createAuthorization(credentials, changed = () => {}) {
  const state = randomBytes(32).toString("hex");
  let resolve,
    reject,
    started = false,
    verifier,
    closed = false;
  const code = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  code.catch(() => {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (
      req.method !== "GET" ||
      url.pathname !== "/callback" ||
      url.searchParams.get("state") !== state
    ) {
      res.writeHead(400).end("Invalid authorization callback");
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (url.searchParams.get("error") || !url.searchParams.get("code")) {
      res.end("Authorization cancelled. Return to SwypikOS.");
      reject(new Error("Authorization cancelled"));
    } else {
      res.end("Authorized. Return to SwypikOS.");
      resolve(url.searchParams.get("code"));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(credentials.redirectPort || 0, "127.0.0.1", resolve);
  });
  const redirectUrl = `http://127.0.0.1:${server.address().port}/callback`;
  credentials.redirectPort = server.address().port;
  let clientInfo = credentials.clientInfo;
  const timer = setTimeout(() => {
    reject(new Error("Authorization timed out. Try connecting again."));
    server.close();
  }, 180000);
  return {
    code,
    started: () => started,
    close: () => {
      closed = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    },
    provider: {
      redirectUrl,
      clientMetadata: {
        client_name: "SwypikOS",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => state,
      clientInformation: () => clientInfo,
      saveClientInformation: (info) => {
        clientInfo = info;
        credentials.clientInfo = info;
      },
      tokens: () => credentials.tokens,
      saveTokens: (tokens) => {
        credentials.tokens = tokens;
        changed();
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      redirectToAuthorization: async (url) => {
        if (closed)
          throw new Error("Authorization expired. Reconnect this service.");
        if (!safeURL(url.toString()))
          throw new Error("Unsafe authorization URL");
        started = true;
        await require("electron").shell.openExternal(url.toString());
      },
      invalidateCredentials: (scope) => {
        if (scope === "all" || scope === "tokens") delete credentials.tokens;
        if (scope === "all" || scope === "client") {
          clientInfo = undefined;
          delete credentials.clientInfo;
        }
      },
    },
  };
}
module.exports = { createAuthorization };
