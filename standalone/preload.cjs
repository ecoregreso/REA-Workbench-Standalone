const {contextBridge, ipcRenderer, webUtils} = require('electron');
const invoke = name => input => ipcRenderer.invoke(`rea-workbench:${name}`, input);
contextBridge.exposeInMainWorld('reaWorkbench', {
  listResults: invoke('list-results'), readResult: invoke('read-result'), importResults: invoke('import-results'), exportResults: invoke('export-results'),
  providerSettings: invoke('provider-settings'), chooseProviderSetting: invoke('choose-provider-setting'), clearProviderSetting: invoke('clear-provider-setting'),
  copyText: invoke('copy-text'),
  status: invoke('status'), connect: invoke('connect'), doctor: invoke('doctor'),
  chooseToolInput: invoke('choose-tool-input'),
  chooseTarget: invoke('choose-target'),
  chooseDroppedTarget: file => ipcRenderer.invoke('rea-workbench:choose-dropped-target', webUtils.getPathForFile(file)),
  openTarget: invoke('open-target'), callTool: invoke('call-tool'), cancel: invoke('cancel'), reset: invoke('reset'),
  previewDossier: invoke('preview-dossier'), exportDossier: invoke('export-dossier'), exportPdf: invoke('export-pdf'), readArtifact: invoke('read-artifact'), mcpConfig: invoke('mcp-config'),
  onEvent: callback => {const listener = (_event, message) => callback(message); ipcRenderer.on('rea-workbench:event', listener); return () => ipcRenderer.removeListener('rea-workbench:event', listener);}
});
