// SwypikOS desktop. Native application views share one isolated platform session.
let browserHistory = [],
  historyIndex = -1,
  isWebViewActive = false;
let defaultUrl = "https://swypik.com",
  omnibarBusy = false;
let activeView = "apps",
  activeCategory = "all",
  apps = [],
  places = [];
let currentPath = "",
  directoryItems = [],
  fileHistory = [],
  fileRequest = 0,
  previewRequest = 0;
let terminalBusy = false;
let pinned = ["home", "go", "movies"];
try {
  const saved = JSON.parse(localStorage.getItem("swypikos-pinned"));
  if (Array.isArray(saved)) pinned = saved.filter((x) => typeof x === "string");
} catch (_) {}
const groupNames = {
  all: "All apps",
  shopping: "Shopping",
  mobility: "Go & Food",
  travel: "Travel",
  entertainment: "Entertainment",
  community: "Community",
  business: "Business",
  settings: "Account",
  local: "Local tools",
};
const iconNames = {
  Home: "brand",
  Compass: "globe",
  LayoutGrid: "grid",
  ShoppingBag: "bag",
  ShoppingCart: "bag",
  Package: "bag",
  Car: "car",
  Bike: "car",
  Truck: "car",
  UtensilsCrossed: "food",
  BedDouble: "bed",
  Plane: "plane",
  Clapperboard: "film",
  Video: "film",
  Music: "music",
  Gamepad2: "game",
  Newspaper: "news",
  MessageSquareText: "chat",
  Radio: "live",
  User: "user",
  Sparkles: "spark",
  Store: "bag",
  Bell: "live",
  Target: "spark",
  Bookmark: "star",
  KeyRound: "bed",
  Shield: "settings",
  Luggage: "bag",
  HelpCircle: "chat",
};
const groupColors = {
  shopping: "rose",
  mobility: "cyan",
  travel: "cyan",
  entertainment: "",
  community: "rose",
  business: "ink",
  settings: "ink",
  local: "amber",
};
function el(id) {
  return document.getElementById(id);
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}
function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text, cls, action) {
  const b = node("button", cls, text);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
}
async function requestJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      const data = JSON.parse(raw);
      message = data.error || data.feedback || raw;
    } catch (_) {}
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json();
}
function post(url, data) {
  return requestJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNativeWorkspace();
  initConnectors();
  initWorkspaceSize();
  initClock();
  initTelemetry();
  loadApps();
  loadPlaces();
  el("workspace-search").addEventListener("input", () => {
    if (activeView === "files") renderFiles();
    else if (activeView === "apps" || activeView === "favorites") renderApps();
  });
  el("omnibar-form").addEventListener("submit", (e) => {
    e.preventDefault();
    handleOmnibarSubmit();
  });
  el("path-form").addEventListener("submit", (e) => {
    e.preventDefault();
    loadDirectory(el("folder-path").value.trim());
  });
  el("terminal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runTerminal();
  });
  el("browser-form").addEventListener("submit", (e) => {
    e.preventDefault();
    navigateToUrl(el("browser-url-input").value);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      focusAssistant();
    }
    if (e.key === "Escape") {
      if (document.body.classList.contains("chat-expanded"))
        toggleChatSize(false);
      closeResponses();
      el("omnibar-feedback").classList.add("hidden");
    }
    if (
      e.key === "/" &&
      !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
    ) {
      e.preventDefault();
      el("workspace-search").focus();
    }
  });
});
function initClock() {
  const update = () => {
    const now = new Date();
    if (el("clock-time"))
      el("clock-time").textContent = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    if (el("clock-date"))
      el("clock-date").textContent = now.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
  };
  update();
  setInterval(update, 1000);
}
async function initTelemetry() {
  const hw = el("hardware-status");
  try {
    const data = await requestJSON("/api/telemetry");
    if (data.default_url) defaultUrl = data.default_url;
    if (hw)
      hw.textContent = data.cuda?.is_hardware_live
        ? data.cuda.device_name
        : "GPU telemetry unavailable";
  } catch (_) {
    if (hw) hw.textContent = "Desktop server unavailable";
  } finally {
    setTimeout(initTelemetry, 10000);
  }
}
function setView(view) {
  if (view === "favorites") {
    activeCategory = "all";
    renderCategories();
  }
  activeView = view;
  const panel = view === "favorites" ? "apps" : view;
  for (const name of [
    "apps",
    "files",
    "browser",
    "terminal",
    "connections",
    "native",
  ])
    el(name + "-view").classList.toggle("hidden", name !== panel);
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    b.setAttribute("aria-pressed", String(b.dataset.view === view));
  });
  el("browser-window").classList.remove("hidden");
  el("workspace-search").value = "";
  el("workspace-search").disabled = !["apps", "favorites", "files"].includes(
    view,
  );
  el("workspace-search").placeholder =
    view === "files" ? "Find in this folder…" : "Find an app…";
  el("current-workspace-title").textContent = {
    apps: "Swypik ecosystem",
    favorites: "Pinned applications",
    files: "Local files",
    browser: "Browser",
    terminal: "Terminal",
    connections: "Connected services",
    native: "Application workspace",
  }[view];
  if (view === "files") {
    if (!currentPath) loadDirectory("");
    else renderFiles();
  }
  if (view === "apps" || view === "favorites") renderApps();
  if (view === "terminal") el("terminal-input").focus();
  syncNativeBounds();
}
function refreshView() {
  if (activeView === "files") loadDirectory(currentPath, false);
  else if (activeView === "browser") browserReload();
  else {
    loadApps();
    loadPlaces();
  }
}
async function loadApps() {
  try {
    const data = await requestJSON("/api/apps");
    apps = data.apps;
    const order = [
      "home",
      "go",
      "movies",
      "music",
      "shop",
      "food",
      "stays",
      "fly",
      "gaming",
      "news",
      "messages",
      "live",
      "studio",
      "nexus",
    ];
    apps.sort((a, b) => {
      const rank = (x) => {
        const i = order.indexOf(x.id);
        return i < 0 ? order.length : i;
      };
      return rank(a) - rank(b);
    });
    el("platform-origin").textContent = data.platform_url;
    renderCategories();
    renderApps();
    renderPins();
  } catch (error) {
    el("app-grid").replaceChildren(
      node("p", "empty-state", "Applications unavailable. " + error.message),
      button("Retry", "retry-button", loadApps),
    );
  }
}
function renderCategories() {
  const root = el("category-tabs");
  root.replaceChildren();
  for (const [id, label] of Object.entries(groupNames)) {
    const b = button(label, id === activeCategory ? "active" : "", () => {
      activeCategory = id;
      renderCategories();
      renderApps();
    });
    b.setAttribute("aria-pressed", String(id === activeCategory));
    root.append(b);
  }
}
function renderApps() {
  const q = el("workspace-search").value.toLowerCase();
  const filtered = apps.filter(
    (a) =>
      (activeView !== "favorites" || pinned.includes(a.id)) &&
      (activeCategory === "all" || a.group === activeCategory) &&
      `${a.name} ${a.group} ${a.id}`.toLowerCase().includes(q),
  );
  const grid = el("app-grid");
  grid.replaceChildren();
  for (const app of filtered) {
    const card = button("", "app-card", () => appDetails(app));
    const symbol = node("span", "app-symbol " + (groupColors[app.group] || ""));
    symbol.append(icon(iconNames[app.icon] || "grid"));
    card.append(symbol);
    const text = node("span");
    text.append(
      node("strong", "", app.name),
      node(
        "small",
        "",
        app.local ? "Local service" : groupNames[app.group] || app.group,
      ),
    );
    card.append(text, node("span", "card-arrow", "↗"));
    card.setAttribute("aria-label", "Open " + app.name + " details");
    grid.append(card);
  }
  if (!filtered.length)
    grid.append(
      node(
        "p",
        "empty-state",
        activeView === "favorites"
          ? "No pinned apps match. Pin an app from its details."
          : "No apps match your search.",
      ),
    );
  el("apps-count").textContent = `${filtered.length} applications`;
}
function renderPins() {
  const root = el("pinned-apps");
  root.replaceChildren();
  for (const id of pinned.slice(0, 3)) {
    const app = apps.find((a) => a.id === id);
    if (!app) continue;
    const b = button("", "", () => launchApp(id));
    const mark = node("span", "pin-logo");
    mark.append(icon(iconNames[app.icon] || "grid"));
    b.append(mark, node("span", "", app.name));
    root.append(b);
  }
  if (!root.childNodes.length)
    root.append(button("Choose apps", "", () => setView("apps")));
}
function appDetails(app) {
  const root = el("app-detail");
  root.replaceChildren();
  const mark = node("span", "app-symbol " + (groupColors[app.group] || ""));
  mark.append(icon(iconNames[app.icon] || "grid"));
  root.append(mark, node("h2", "", app.name), node("code", "", app.url));
  const note = app.local
    ? "This local service must be running. Opens inside the desktop workspace."
    : "Opens inside SwypikOS. Platform apps share your desktop Swypik session.";
  root.append(node("p", "", note));
  if (app.feature)
    root.append(
      node(
        "p",
        "",
        `Availability is controlled by Swypik (${app.feature}). A disabled service may show an unavailable page.`,
      ),
    );
  if (app.roles?.length)
    root.append(
      node(
        "p",
        "",
        `Requires the ${app.roles.join(" / ")} role. Sign in through Swypik.`,
      ),
    );
  const actions = node("div", "dialog-actions");
  actions.append(
    button("Open in workspace →", "primary-button", () => launchApp(app.id)),
  );
  const link = node("a", "soft-button", "Open in browser");
  link.href = app.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  actions.append(link);
  const pin = button(
    pinned.includes(app.id) ? "Unpin" : "Pin app",
    "soft-button",
    () => {
      pinned = pinned.includes(app.id)
        ? pinned.filter((id) => id !== app.id)
        : [app.id, ...pinned];
      try {
        localStorage.setItem("swypikos-pinned", JSON.stringify(pinned));
      } catch (_) {}
      renderPins();
      renderApps();
      appDetails(app);
    },
  );
  actions.append(pin);
  root.append(actions, node("p", "launch-status", ""));
  if (!el("app-dialog").open) el("app-dialog").showModal();
}
async function launchApp(id) {
  const app = apps.find((a) => a.id === id);
  if (!app) {
    showFeedback("Application catalog is not available yet.");
    return;
  }
  try {
    if (el("app-dialog").open) el("app-dialog").close();
    setView("native");
    el("native-title").textContent = app.name;
    if (!window.swypikDesktop) {
      el("native-message").textContent =
        "Aplicațiile integrate rulează în fereastra desktop. Deschide Start-SwypikOS.bat din proiect; această pagină este previzualizarea web.";
      return;
    }
    el("native-message").textContent = "Se deschide " + app.name + "…";
    const opened = await window.swypikDesktop.open(id);
    nativeApp = id;
    nativeFailed = !!opened.error;
    if (opened.error)
      el("native-message").textContent = opened.error + ". Try Reload.";
    if (!runningApps.includes(id)) runningApps.push(id);
    renderRunningApps();
    syncNativeBounds();
  } catch (error) {
    setView("apps");
    appDetails(app);
    el("app-detail").querySelector(".launch-status").textContent =
      error.message;
  }
}
async function loadPlaces() {
  try {
    places = await requestJSON("/api/workspaces");
    for (const id of ["workspace-places", "connection-workspaces"]) {
      const root = el(id);
      root.replaceChildren();
      for (const place of places)
        root.append(
          button(place.name, "", () => {
            setView("files");
            loadDirectory(place.path);
          }),
        );
    }
  } catch (error) {
    showFeedback("Linked workspaces unavailable: " + error.message);
  }
}
function basename(path) {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || path
  );
}
async function loadDirectory(path, remember = true) {
  const seq = ++fileRequest;
  ++previewRequest;
  el("file-grid").replaceChildren(node("p", "empty-state", "Opening folder…"));
  el("files-view")
    .querySelector(".files-split")
    .classList.remove("has-preview");
  el("file-inspector").replaceChildren(
    node("p", "empty-state", "Select a file to preview."),
  );
  try {
    const data = await requestJSON(
      "/api/files?path=" + encodeURIComponent(path),
    );
    if (seq !== fileRequest) return;
    if (remember && currentPath && currentPath !== data.path)
      fileHistory.push(currentPath);
    currentPath = data.path;
    directoryItems = data.items || [];
    el("folder-path").value = currentPath;
    el("folder-name").textContent = basename(currentPath);
    el("files-back").disabled = !fileHistory.length;
    el("files-up").disabled = isRootPath(currentPath);
    el("workspace-search").value = "";
    renderFiles();
  } catch (error) {
    if (seq !== fileRequest) return;
    el("folder-path").value = currentPath;
    el("file-grid").replaceChildren(
      node("p", "empty-state", error.message),
      button("Return to workspace", "soft-button", () => loadDirectory("")),
    );
  }
}
function isRootPath(path) {
  const normalize = (p) =>
    p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return places.some((p) => normalize(p.path) === normalize(path));
}
function filesBack() {
  const path = fileHistory.pop();
  if (path !== undefined) loadDirectory(path, false);
}
function filesUp() {
  if (isRootPath(currentPath)) return;
  const normalized = currentPath.replace(/\\/g, "/").replace(/\/$/, "");
  const index = normalized.lastIndexOf("/");
  if (index >= 0) loadDirectory(normalized.slice(0, index + 1));
}
function fileSize(size) {
  return size < 1024
    ? size + " B"
    : size < 1024 * 1024
      ? (size / 1024).toFixed(1) + " KB"
      : (size / (1024 * 1024)).toFixed(1) + " MB";
}
function renderFiles() {
  const q = el("workspace-search").value.toLowerCase();
  const items = directoryItems
    .filter((i) => i.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name),
    );
  const root = el("file-grid");
  root.replaceChildren();
  for (const item of items) {
    const b = button("", "file-tile", () =>
      item.is_dir ? loadDirectory(item.path) : previewFile(item),
    );
    const glyph = node("span", item.is_dir ? "folder-glyph" : "file-glyph");
    if (!item.is_dir) glyph.append(icon("file"));
    const label = node("span", "file-label");
    label.append(
      node("strong", "", item.name),
      node("small", "", item.is_dir ? "Folder" : fileSize(item.size)),
    );
    b.append(glyph, label);
    b.title = item.name;
    b.setAttribute(
      "aria-label",
      (item.is_dir ? "Open folder " : "Preview file ") + item.name,
    );
    root.append(b);
  }
  if (!items.length)
    root.append(
      node(
        "p",
        "empty-state",
        q ? "No files match your search." : "This folder is empty.",
      ),
    );
  el("file-count").textContent = items.length + " items";
}
async function previewFile(item) {
  const seq = ++previewRequest;
  const root = el("file-inspector");
  root.replaceChildren();
  el("files-view").querySelector(".files-split").classList.add("has-preview");
  const header = node("div", "inspector-title");
  header.append(
    node("h3", "", item.name),
    button("×", "icon-button", () => {
      ++previewRequest;
      el("files-view")
        .querySelector(".files-split")
        .classList.remove("has-preview");
    }),
  );
  root.append(
    header,
    node("p", "file-meta", fileSize(item.size) + " · " + item.mod_time),
  );
  const pre = node("pre", "file-preview", "Loading preview…");
  root.append(
    pre,
    button("Copy path", "soft-button", async () => {
      try {
        await navigator.clipboard.writeText(item.path);
        showFeedback("File path copied.");
      } catch (_) {
        showFeedback("Clipboard unavailable.");
      }
    }),
  );
  try {
    const data = await requestJSON(
      "/api/file-preview?path=" + encodeURIComponent(item.path),
    );
    if (seq === previewRequest) pre.textContent = data.text || "(empty file)";
  } catch (error) {
    if (seq === previewRequest) pre.textContent = error.message;
  }
}
function focusAssistant() {
  el("omnibar-input").focus();
}
function closeResponses() {
  if (document.body?.classList.contains("chat-expanded")) toggleChatSize(false);
  el("response-panel").classList.add("hidden");
}
function toggleResponses() {
  if (document.body?.classList.contains("chat-expanded")) {
    closeResponses();
    return;
  }
  el("response-panel").classList.toggle("hidden");
}
function addResponse(role, text) {
  const history = el("response-history");
  if (!history) return;
  const row = node("div", "chat-entry " + role);
  row.append(
    node(
      "strong",
      "",
      role === "user" ? "YOU" : role === "error" ? "UNAVAILABLE" : "ILARIA",
    ),
    node("span", "", text),
  );
  history.append(row);
  while (history.childNodes.length > 60) history.firstChild.remove();
  el("response-panel").classList.remove("hidden");
  history.scrollTop = history.scrollHeight;
}
async function handleOmnibarSubmit() {
  const input = el("omnibar-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text || omnibarBusy) return;
  const open = text.match(/^(?:open|deschide)\s+(.+)$/i);
  if (open) {
    const name = open[1].toLowerCase();
    const app = apps.find(
      (a) =>
        a.id.toLowerCase() === name ||
        a.name.toLowerCase() === name ||
        ("swypik " + a.name).toLowerCase() === name,
    );
    if (app) {
      input.value = "";
      await launchApp(app.id);
      return;
    }
    if (
      ["files", "workspace", "foldere", "terminal", "browser", "apps"].includes(
        name,
      )
    ) {
      setView({ workspace: "files", foldere: "files" }[name] || name);
      input.value = "";
      return;
    }
    const place = places.find((p) => p.name.toLowerCase() === name);
    if (place) {
      setView("files");
      loadDirectory(place.path);
      input.value = "";
      return;
    }
  }
  omnibarBusy = true;
  const send = el("execute-button");
  if (send) send.disabled = true;
  showFeedback("Connecting to Ilaria…");
  try {
    const res = await fetch("/api/omnibar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
    });
    if (!res.ok) {
      const failure = await res.json().catch(() => ({}));
      throw new Error(
        failure.error ||
          failure.feedback ||
          `Request failed (HTTP ${res.status})`,
      );
    }
    const data = await res.json();
    if (data.type === "NAVIGATE") navigateToUrl(data.url);
    else if (data.type === "TERMINAL") {
      setView("terminal");
      appendTerminal(text, data.output || data.feedback, data.success);
      showFeedback(data.success ? "Command finished." : "Command failed.");
    } else {
      addResponse("user", text);
      addResponse(
        "assistant",
        data.reply || data.feedback || "No response received.",
      );
      el("omnibar-feedback").classList.add("hidden");
    }
    input.value = "";
  } catch (error) {
    showFeedback(`Could not execute: ${error.message}`);
  } finally {
    omnibarBusy = false;
    if (send) send.disabled = false;
  }
}
function appendTerminal(command, output, success) {
  const pre = el("terminal-output");
  pre.textContent += `\n› ${command}\n${output}\n${success ? "" : "[Command failed]\n"}`;
  if (pre.textContent.length > 100000)
    pre.textContent = pre.textContent.slice(-100000);
  pre.scrollTop = pre.scrollHeight;
}
async function runTerminal() {
  const input = el("terminal-input");
  const command = input.value.trim();
  if (!command || terminalBusy) return;
  terminalBusy = true;
  el("terminal-run").disabled = true;
  try {
    const data = await post("/api/omnibar", { input: "run " + command });
    appendTerminal(command, data.output || data.feedback, data.success);
    if (data.success) input.value = "";
  } catch (error) {
    appendTerminal(command, error.message, false);
  } finally {
    terminalBusy = false;
    el("terminal-run").disabled = false;
  }
}
function navigateToUrl(targetUrl) {
  targetUrl = targetUrl.trim();
  if (!targetUrl) return;
  if (!/^https?:\/\//i.test(targetUrl)) {
    if (targetUrl.includes(".") && !targetUrl.includes(" "))
      targetUrl = "https://" + targetUrl;
    else
      targetUrl = "https://duckduckgo.com/?q=" + encodeURIComponent(targetUrl);
  }
  try {
    const parsed = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    targetUrl = parsed.href;
  } catch (_) {
    showFeedback("Invalid website address");
    return;
  }
  if (historyIndex < browserHistory.length - 1)
    browserHistory = browserHistory.slice(0, historyIndex + 1);
  browserHistory.push(targetUrl);
  historyIndex = browserHistory.length - 1;
  applyNavigation(targetUrl);
}
function applyNavigation(url) {
  const win = el("browser-window");
  if (win) {
    win.classList.remove("hidden");
    win.style.opacity = "1";
    win.style.transform = "";
  }
  if (typeof document.querySelectorAll === "function") setView("browser");
  const canvas = el("canvas-view"),
    web = el("web-view"),
    iframe = el("browser-iframe");
  if (canvas && web) {
    canvas.classList.add("hidden");
    web.classList.remove("hidden");
    isWebViewActive = true;
  }
  if (el("browser-url-input")) el("browser-url-input").value = url;
  if (el("web-status-badge"))
    el("web-status-badge").textContent =
      "Sandboxed preview · " +
      new URL(url).hostname +
      " · Use Open externally if unsupported";
  if (iframe) iframe.src = "/api/proxy?url=" + encodeURIComponent(url);
}
function browserBack() {
  if (historyIndex > 0) applyNavigation(browserHistory[--historyIndex]);
  else {
    el("canvas-view").classList.remove("hidden");
    el("web-view").classList.add("hidden");
    isWebViewActive = false;
  }
}
function browserForward() {
  if (historyIndex < browserHistory.length - 1)
    applyNavigation(browserHistory[++historyIndex]);
}
function browserReload() {
  if (isWebViewActive) el("browser-iframe").src = el("browser-iframe").src;
}
function openCurrentUrlExternal() {
  window.open(
    browserHistory[historyIndex] || defaultUrl,
    "_blank",
    "noopener,noreferrer",
  );
}
async function shareCurrent() {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(
      browserHistory[historyIndex] || defaultUrl,
    );
    showFeedback("Link copied.");
  } catch (error) {
    showFeedback(`Could not copy link: ${error.message}`);
  }
}
function showFeedback(message) {
  const box = el("omnibar-feedback");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.classList.add("hidden"), 7000);
}
