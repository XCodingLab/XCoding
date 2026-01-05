const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xcoding", {
  terminal: {
    create: (options) => ipcRenderer.invoke("terminal:create", options),
    write: (sessionId, data) => ipcRenderer.invoke("terminal:write", { sessionId, data }),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke("terminal:resize", { sessionId, cols, rows }),
    dispose: (sessionId) => ipcRenderer.invoke("terminal:dispose", { sessionId }),
    getBuffer: (sessionId, maxBytes) => ipcRenderer.invoke("terminal:getBuffer", { sessionId, maxBytes }),
    onData: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("terminal:data", wrapped);
      return () => ipcRenderer.off("terminal:data", wrapped);
    }
  },
  preview: {
    create: (payload) => ipcRenderer.invoke("preview:create", payload),
    show: (payload) => ipcRenderer.invoke("preview:show", payload),
    hide: (payload) => ipcRenderer.invoke("preview:hide", payload),
    navigate: (payload) => ipcRenderer.invoke("preview:navigate", payload),
    destroy: (payload) => ipcRenderer.invoke("preview:destroy", payload),
    setBounds: (payload) => ipcRenderer.invoke("preview:setBounds", payload),
    onConsole: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("preview:console", wrapped);
      return () => ipcRenderer.off("preview:console", wrapped);
    },
    onNetwork: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("preview:network", wrapped);
      return () => ipcRenderer.off("preview:network", wrapped);
    }
  },
  projects: {
    get: () => ipcRenderer.invoke("projects:get"),
    getWorkflow: (projectId) => ipcRenderer.invoke("projects:getWorkflow", { projectId }),
    setWorkflow: (projectId, workflow) => ipcRenderer.invoke("projects:setWorkflow", { projectId, workflow }),
    setSlotPath: (slot, projectPath) => ipcRenderer.invoke("projects:setSlotPath", { slot, path: projectPath }),
    bindCwd: (slot) => ipcRenderer.invoke("projects:bindCwd", { slot }),
    openFolder: (slot) => ipcRenderer.invoke("projects:openFolder", { slot }),
    unbindSlot: (slot) => ipcRenderer.invoke("projects:unbindSlot", { slot }),
    reorderSlots: (slotOrder) => ipcRenderer.invoke("projects:reorderSlots", { slotOrder }),
    setUiLayout: (projectId, layout) => ipcRenderer.invoke("projects:setUiLayout", { projectId, layout }),
    setActiveSlot: (slot) => ipcRenderer.invoke("projects:setActiveSlot", { slot }),
    onSwitchSlot: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("projects:switchSlot", wrapped);
      return () => ipcRenderer.off("projects:switchSlot", wrapped);
    }
    ,
    onState: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("projects:state", wrapped);
      return () => ipcRenderer.off("projects:state", wrapped);
    }
  },
  window: {
    create: (payload) => ipcRenderer.invoke("window:new", payload),
    getDetachedSlots: () => ipcRenderer.invoke("window:getDetachedSlots"),
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximizeToggle: () => ipcRenderer.invoke("window:maximizeToggle"),
    close: () => ipcRenderer.invoke("window:close"),
    onDetachedSlots: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("window:detachedSlots", wrapped);
      return () => ipcRenderer.off("window:detachedSlots", wrapped);
    }
  },
  events: {
    onProjectEvent: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("project:event", wrapped);
      return () => ipcRenderer.off("project:event", wrapped);
    }
  },
  ai: {
    onStatus: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("ai:status", wrapped);
      return () => ipcRenderer.off("ai:status", wrapped);
    },
    onStream: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("ai:stream", wrapped);
      return () => ipcRenderer.off("ai:stream", wrapped);
    },
    stageEdits: (payload) => ipcRenderer.invoke("ai:stageEdits", payload),
    applyAll: (payload) => ipcRenderer.invoke("ai:applyAll", payload),
    revertLast: (payload) => ipcRenderer.invoke("ai:revertLast", payload),
    getStaging: (payload) => ipcRenderer.invoke("ai:getStaging", payload),
    chatStart: (payload) => ipcRenderer.invoke("ai:chatStart", payload),
    chatCancel: (payload) => ipcRenderer.invoke("ai:chatCancel", payload)
  },
  codex: {
    ensureStarted: () => ipcRenderer.invoke("codex:ensureStarted"),
    getStatus: () => ipcRenderer.invoke("codex:getStatus"),
    threadList: (payload) => ipcRenderer.invoke("codex:threadList", payload),
    threadStart: (payload) => ipcRenderer.invoke("codex:threadStart", payload),
    threadResume: (payload) => ipcRenderer.invoke("codex:threadResume", payload),
    threadArchive: (payload) => ipcRenderer.invoke("codex:threadArchive", payload),
    turnStart: (payload) => ipcRenderer.invoke("codex:turnStart", payload),
    turnInterrupt: (payload) => ipcRenderer.invoke("codex:turnInterrupt", payload),
    reviewStart: (payload) => ipcRenderer.invoke("codex:reviewStart", payload),
    modelList: (payload) => ipcRenderer.invoke("codex:modelList", payload),
    skillsList: (payload) => ipcRenderer.invoke("codex:skillsList", payload),
    mcpServerStatusList: (payload) => ipcRenderer.invoke("codex:mcpServerStatusList", payload),
    configRead: (payload) => ipcRenderer.invoke("codex:configRead", payload),
    configValueWrite: (payload) => ipcRenderer.invoke("codex:configValueWrite", payload),
    restart: () => ipcRenderer.invoke("codex:restart"),
    turnRevert: (payload) => ipcRenderer.invoke("codex:turnRevert", payload),
    turnApply: (payload) => ipcRenderer.invoke("codex:turnApply", payload),
    respond: (payload) => ipcRenderer.invoke("codex:respond", payload),
    sessionRead: (payload) => ipcRenderer.invoke("codex:sessionRead", payload),
    writeImageAttachment: (payload) => ipcRenderer.invoke("codex:writeImageAttachment", payload),
    readLocalImageAsDataUrl: (payload) => ipcRenderer.invoke("codex:readLocalImageAsDataUrl", payload),
    onEvent: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("codex:event", wrapped);
      return () => ipcRenderer.off("codex:event", wrapped);
    },
    onRequest: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("codex:request", wrapped);
      return () => ipcRenderer.off("codex:request", wrapped);
    }
  },
  project: {
    readFile: (payload) => ipcRenderer.invoke("project:fsReadFile", payload),
    writeFile: (payload) => ipcRenderer.invoke("project:fsWriteFile", payload),
    listDir: (payload) => ipcRenderer.invoke("project:fsListDir", payload),
    searchPaths: (payload) => ipcRenderer.invoke("project:searchPaths", payload),
    gitStatus: (payload) => ipcRenderer.invoke("project:gitStatus", payload),
    searchFiles: (payload) => ipcRenderer.invoke("project:searchFiles", payload),
    searchContent: (payload) => ipcRenderer.invoke("project:searchContent", payload),
    replaceContent: (payload) => ipcRenderer.invoke("project:replaceContent", payload),
    lspDidOpen: (payload) => ipcRenderer.invoke("project:lspDidOpen", payload),
    lspDidChange: (payload) => ipcRenderer.invoke("project:lspDidChange", payload),
    lspDidClose: (payload) => ipcRenderer.invoke("project:lspDidClose", payload),
    lspRequest: (payload) => ipcRenderer.invoke("project:lspRequest", payload),
    deleteFile: (payload) => ipcRenderer.invoke("project:fsDeleteFile", payload),
    mkdir: (payload) => ipcRenderer.invoke("project:fsMkdir", payload),
    rename: (payload) => ipcRenderer.invoke("project:fsRename", payload),
    deleteDir: (payload) => ipcRenderer.invoke("project:fsDeleteDir", payload),
    tsDiagnostics: (payload) => ipcRenderer.invoke("project:tsDiagnostics", payload)
  },
  fs: {
    readFile: (payload) => ipcRenderer.invoke("fs:readFile", payload)
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    setLanguage: (language) => ipcRenderer.invoke("settings:setLanguage", { language }),
    setAutoApply: (enabled) => ipcRenderer.invoke("settings:setAutoApply", { enabled }),
    setAiConfig: (payload) => ipcRenderer.invoke("settings:setAiConfig", payload),
    setLayout: (payload) => ipcRenderer.invoke("settings:setLayout", payload)
  },
  os: {
    copyText: (text) => ipcRenderer.invoke("os:copyText", { text })
  },
  // window controls are defined above under xcoding.window
});
