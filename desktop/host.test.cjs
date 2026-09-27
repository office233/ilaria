const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
test("host embeds apps inside one window, preserves views and rejects remote IPC", async () => {
  const handlers = new Map(),
    children = [],
    windows = [],
    errors = [];
  class Contents extends EventEmitter {
    mainFrame = { url: "http://127.0.0.1:1234/" };
    navigationHistory = { canGoBack: () => false };
    setWindowOpenHandler(handler) {
      this.popup = handler;
    }
    async loadURL(url) {
      this.url = url;
    }
    getURL() {
      return this.url;
    }
    send() {}
    close() {
      this.closed = true;
    }
    isDestroyed() {
      return !!this.closed;
    }
  }
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = new Contents();
      this.contentView = { addChildView: (v) => children.push(v) };
      windows.push(this);
    }
    async loadURL(url) {
      await this.webContents.loadURL(url);
    }
    isDestroyed() {
      return false;
    }
    getContentSize() {
      return [1440, 960];
    }
  }
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = new Contents();
    }
    setVisible(value) {
      this.visible = value;
    }
    setBounds(value) {
      this.bounds = value;
    }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    setName() {},
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    quit() {},
    getPath: () => "unused-test-vault",
  });
  const electron = {
    app,
    BrowserWindow: Window,
    WebContentsView: View,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      }),
    },
    dialog: { showErrorBox: (_, message) => errors.push(message) },
  };
  const daemon = new EventEmitter();
  daemon.stdout = new EventEmitter();
  daemon.stderr = new EventEmitter();
  daemon.kill = () => {};
  const context = {
    __dirname,
    process: { env: {} },
    setTimeout,
    clearTimeout,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        apps: [
          { id: "go", name: "Go", url: "https://swypik.com/go" },
          { id: "movies", name: "Movies", url: "https://swypik.com/movies" },
        ],
      }),
    }),
    require(name) {
      if (name === "electron") return electron;
      if (name === "node:child_process")
        return {
          spawn: () => {
            setImmediate(() =>
              daemon.stdout.emit(
                "data",
                Buffer.from("READY (http://127.0.0.1:1234)"),
              ),
            );
            return daemon;
          },
        };
      if (name === "./connectors.cjs") return { ConnectorHub: class {} };
      return require(name);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"),
    context,
  );
  for (let i = 0; i < 10 && !handlers.has("apps:open"); i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(windows.length, 1);
  const shell = windows[0].webContents,
    event = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (channel, value) => handlers.get(channel)(event, value);
  await invoke("apps:open", "go");
  invoke("apps:layout", { x: 150, y: 250, width: 900, height: 430 });
  assert.equal(children[0].visible, true);
  await invoke("apps:open", "movies");
  assert.equal(children[0].visible, false);
  await invoke("apps:open", "go");
  assert.equal(
    children.length,
    2,
    "Reopening an app reuses its existing native view",
  );
  assert.equal(children[0].webContents.url, "https://swypik.com/go");
  assert.equal(
    children[0].options.webPreferences.partition,
    children[1].options.webPreferences.partition,
  );
  assert.notEqual(
    children[0].options.webPreferences.partition,
    windows[0].options.webPreferences.partition,
  );
  assert.equal(children[0].options.webPreferences.preload, undefined);
  assert.equal(children[0].options.webPreferences.nodeIntegration, false);
  assert.throws(
    () =>
      handlers.get("apps:open")(
        {
          sender: children[0].webContents,
          senderFrame: children[0].webContents.mainFrame,
        },
        "go",
      ),
    /Untrusted/,
  );
  await assert.rejects(invoke("apps:open", "unknown"), /Unknown/);
  invoke("apps:layout", null);
  assert.equal(children[0].visible, false);
  invoke("apps:action", "close");
  assert.equal(children[0].webContents.closed, true);
  app.emit("before-quit");
});
