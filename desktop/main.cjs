const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  dialog,
} = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { safeURL, validSender, clampBounds } = require("./policy.cjs");
const root = path.resolve(__dirname, "..");
let daemon, win, origin, catalog, current;
const views = new Map();
app.setName("SwypikOS");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    win?.restore();
    win?.focus();
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("SwypikOS", error.message);
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  for (const view of views.values())
    if (!view.webContents.isDestroyed()) view.webContents.close();
  daemon?.kill();
});
async function start() {
  origin = await new Promise((resolve, reject) => {
    daemon = spawn(
      path.join(root, "bin", "swypik-os.exe"),
      ["-headless", "-port", "0"],
      {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          SWYPIK_BIND_HOST: "127.0.0.1",
          SWYPIK_STATIC_DIR: path.join(root, "ui", "web"),
        },
      },
    );
    const timer = setTimeout(
      () => reject(new Error("Desktop service did not start.")),
      20000,
    );
    let output = "";
    daemon.stderr.on("data", () => {});
    daemon.stdout.on("data", (data) => {
      output = (output + data.toString()).slice(-32000);
      const match = output.match(/READY \((http:\/\/127\.0\.0\.1:\d+)\)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    daemon.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    daemon.on("exit", () => {
      clearTimeout(timer);
      reject(
        new Error("Desktop service exited. Build bin/swypik-os.exe first."),
      );
    });
  });
  const response = await fetch(origin + "/api/apps");
  if (!response.ok) throw new Error("Application catalog unavailable.");
  catalog = (await response.json()).apps;
  const remoteSession = session.fromPartition("persist:swypik-apps");
  const permissions = new Set();
  const permissionKey = (url, permission) => {
    try {
      return new URL(url).origin + ":" + permission;
    } catch {
      return "";
    }
  };
  remoteSession.setPermissionRequestHandler(
    async (wc, permission, callback, details) => {
      if (
        !win ||
        win.isDestroyed() ||
        !["geolocation", "media", "notifications"].includes(permission)
      ) {
        callback(false);
        return;
      }
      const requester = details.requestingUrl || wc.getURL();
      const key = permissionKey(requester, permission);
      if (!key || !safeURL(requester)) {
        callback(false);
        return;
      }
      try {
        const choice = await dialog.showMessageBox(win, {
          type: "question",
          buttons: ["Deny", "Allow for this session"],
          defaultId: 0,
          cancelId: 0,
          title: "Application permission",
          message: new URL(requester).origin,
          detail: `Requests ${permission}${details.mediaTypes ? ": " + details.mediaTypes.join(", ") : ""}.`,
        });
        if (choice.response === 1) permissions.add(key);
        callback(choice.response === 1);
      } catch {
        callback(false);
      }
    },
  );
  remoteSession.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin) =>
      permission !== "media" &&
      permissions.has(permissionKey(requestingOrigin, permission)),
  );
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 700,
    title: "SwypikOS",
    backgroundColor: "#f7f7fc",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: "persist:swypik-shell",
    },
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const handle = (name, fn) =>
    ipcMain.handle(name, (event, arg) => {
      if (!validSender(event, win.webContents, origin))
        throw new Error("Untrusted caller");
      return fn(arg);
    });
  const status = (data) => {
    if (!win.isDestroyed()) win.webContents.send("apps:status", data);
  };
  handle("window:fullscreen", () => {
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });
  handle("apps:open", async (id) => {
    const entry = catalog.find((a) => a.id === id);
    if (!entry || !safeURL(entry.url)) throw new Error("Unknown application");
    for (const view of views.values()) view.setVisible(false);
    let view = views.get(id);
    if (!view) {
      view = new WebContentsView({
        webPreferences: {
          partition: "persist:swypik-apps",
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      views.set(id, view);
      win.contentView.addChildView(view);
      view.setVisible(false);
      const wc = view.webContents;
      wc.on("will-navigate", (event, url) => {
        if (!safeURL(url) || new URL(url).origin === origin)
          event.preventDefault();
      });
      wc.on("will-redirect", (event, url) => {
        if (!safeURL(url) || new URL(url).origin === origin)
          event.preventDefault();
      });
      wc.setWindowOpenHandler(({ url }) => {
        if (safeURL(url) && new URL(url).origin !== origin)
          wc.loadURL(url).catch(() => {});
        return { action: "deny" };
      });
      wc.on("did-start-loading", () => {
        view.loadError = null;
        status({ id, state: "loading" });
      });
      wc.on("did-stop-loading", () => {
        if (!view.loadError) status({ id, state: "ready", url: wc.getURL() });
      });
      wc.on("did-fail-load", (_e, code, description, _url, mainFrame) => {
        if (mainFrame && code !== -3) {
          view.loadError = description;
          status({ id, state: "error", message: description });
        }
      });
      wc.loadURL(entry.url).catch(() => {});
    }
    current = id;
    return { id, name: entry.name, error: view.loadError || null };
  });
  handle("apps:layout", (bounds) => {
    const view = views.get(current);
    if (!view) return;
    const box = clampBounds(bounds, win.getContentSize());
    view.setVisible(!!box && box.width > 0 && box.height > 0);
    if (box) view.setBounds(box);
  });
  handle("apps:action", (action) => {
    const view = views.get(current);
    if (!view) return;
    if (action === "back" && view.webContents.navigationHistory.canGoBack())
      view.webContents.navigationHistory.goBack();
    if (action === "reload") view.webContents.reload();
    if (action === "close") {
      view.webContents.close();
      views.delete(current);
      current = null;
    }
  });
  const { ConnectorHub } = require("./connectors.cjs");
  const hub = new ConnectorHub(app.getPath("userData"));
  handle("connectors:list", () => hub.list());
  handle("connectors:connect", (config) => hub.connect(config));
  handle("connectors:disconnect", (id) => hub.disconnect(id));
  handle("connectors:tools", (id) => hub.tools(id));
  handle("connectors:call", async (request) => {
    const result = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Cancel", "Run tool"],
      defaultId: 0,
      cancelId: 0,
      title: "Connector action",
      message: `${request.id}: ${request.name}`,
      detail: JSON.stringify(request.arguments, null, 2).slice(0, 8000),
    });
    if (result.response !== 1) throw new Error("Action cancelled");
    return hub.call(request);
  });
  await win.loadURL(origin);
}
