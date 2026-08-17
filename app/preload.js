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
  openProject: (id) => ipcRenderer.invoke('project:open', id),

  chooseMediaFolder: () => ipcRenderer.invoke('media:chooseFolder'),

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
