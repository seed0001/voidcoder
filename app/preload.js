const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('vc', {
  init: () => ipcRenderer.invoke('app:init'),
  chooseFolder: () => ipcRenderer.invoke('app:chooseFolder'),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),

  addProject: () => ipcRenderer.invoke('project:add'),
  removeProject: (id) => ipcRenderer.invoke('project:remove', id),
  moveProject: (id, x, y) => ipcRenderer.invoke('project:move', { id, x, y }),
  arrangeProjects: (by, cols) => ipcRenderer.invoke('project:arrange', { by, cols }),
  openProject: (id) => ipcRenderer.invoke('project:open', id),

  createContainer: (name) => ipcRenderer.invoke('container:create', { name }),
  addContainerRefs: (id) => ipcRenderer.invoke('container:addRefs', { id }),
  addContainerRefPaths: (id, paths) => ipcRenderer.invoke('container:addRefPaths', { id, paths }),
  removeContainerRef: (id, refId) => ipcRenderer.invoke('container:removeRef', { id, refId }),
  reindexContainer: (id) => ipcRenderer.invoke('container:reindex', { id }),
  openContainer: (id) => ipcRenderer.invoke('container:open', id),
  removeContainer: (id) => ipcRenderer.invoke('container:remove', id),
  moveContainer: (id, x, y) => ipcRenderer.invoke('container:move', { id, x, y }),
  arrangeContainers: (by, cols) => ipcRenderer.invoke('container:arrange', { by, cols }),
  getContainerStatus: (id) => ipcRenderer.invoke('container:status', id),
  getContainerRelationships: (id) => ipcRenderer.invoke('container:relationships', id),

  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  stop: () => ipcRenderer.invoke('chat:stop'),
  compact: () => ipcRenderer.invoke('chat:compact'),
  undo: () => ipcRenderer.invoke('chat:undo'),
  answerPerm: (id, answer) => ipcRenderer.invoke('perm:answer', { id, answer }),

  newSession: () => ipcRenderer.invoke('session:new'),
  loadSession: (id) => ipcRenderer.invoke('session:load', id),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  sessionChanges: () => ipcRenderer.invoke('session:changes'),

  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setModel: (m) => ipcRenderer.invoke('settings:setModel', m),
  listModels: () => ipcRenderer.invoke('models:list'),

  transcribe: (buffer, mimeType) => ipcRenderer.invoke('voice:transcribe', { buffer, mimeType }),
  speak: (text) => ipcRenderer.invoke('voice:speak', text),

  getSchedule: () => ipcRenderer.invoke('schedule:list'),
  addScheduleTask: (data) => ipcRenderer.invoke('schedule:add', data),
  updateScheduleTask: (id, patch) => ipcRenderer.invoke('schedule:update', { id, patch }),
  toggleSchedule: (id, enabled) => ipcRenderer.invoke('schedule:toggle', { id, enabled }),
  removeScheduleTask: (id) => ipcRenderer.invoke('schedule:remove', id),
  getSchedulerStatus: () => ipcRenderer.invoke('schedule:status'),

  getCostSummary: () => ipcRenderer.invoke('cost:summary'),
  rebuildCost: () => ipcRenderer.invoke('cost:rebuild'),
  getActivitySummary: () => ipcRenderer.invoke('activity:summary'),

  submitBugReport: (data) => ipcRenderer.invoke('bugreport:submit', data),
  openBugReportUrl: (url) => ipcRenderer.invoke('bugreport:openUrl', url),

  getFocusList: () => ipcRenderer.invoke('focus:list'),
  getFocusDetail: (id) => ipcRenderer.invoke('focus:detail', { id }),
  focusAnswer: (id, answer) => ipcRenderer.invoke('focus:answer', { id, answer }),
  focusCancel: (id) => ipcRenderer.invoke('focus:cancel', { id }),

  portalStart: (opts) => ipcRenderer.invoke('portal:start', opts),
  portalStop: () => ipcRenderer.invoke('portal:stop'),
  portalStatus: () => ipcRenderer.invoke('portal:status'),
  onPortalLog: on('portal:log'),
  onPortalStatus: on('portal:status'),

  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: on('updates:status'),

  getModelList: () => ipcRenderer.invoke('model:list'),
  setModelId: (modelId) => ipcRenderer.invoke('model:set', { modelId }),
  getAgentStructure: () => ipcRenderer.invoke('agent:structure'),

  onDelta: on('agent:delta'),
  onReasoningDelta: on('agent:reasoningDelta'),
  onToolStart: on('agent:toolStart'),
  onToolEnd: on('agent:toolEnd'),
  onFileChange: on('agent:fileChange'),
  onTodos: on('agent:todos'),
  onStatus: on('agent:status'),
  onSubagentStart: on('agent:subagentStart'),
  onSubagentEnd: on('agent:subagentEnd'),
  onFocusStart: on('agent:focusStart'),
  onFocusQuestion: on('agent:focusQuestion'),
  onFocusDone: on('agent:focusDone'),
  onFocusResume: on('agent:focusResume'),
  onFocusLog: on('agent:focusLog'),
  onPermAsk: on('perm:ask'),
  onTurnStart: on('agent:turnStart'),
  onTurnEnd: on('agent:turnEnd'),
});
