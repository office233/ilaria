const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("swypikDesktop", {
  fullscreen: () => ipcRenderer.invoke("window:fullscreen"),
  open: (id) => ipcRenderer.invoke("apps:open", id),
  layout: (bounds) => ipcRenderer.invoke("apps:layout", bounds),
  action: (action) => ipcRenderer.invoke("apps:action", action),
  connectors: () => ipcRenderer.invoke("connectors:list"),
  connect: (config) => ipcRenderer.invoke("connectors:connect", config),
  disconnect: (id) => ipcRenderer.invoke("connectors:disconnect", id),
  tools: (id) => ipcRenderer.invoke("connectors:tools", id),
  callTool: (request) => ipcRenderer.invoke("connectors:call", request),
  onStatus: (listener) => {
    const receive = (_, data) => listener(data);
    ipcRenderer.on("apps:status", receive);
    return () => ipcRenderer.removeListener("apps:status", receive);
  },
});
