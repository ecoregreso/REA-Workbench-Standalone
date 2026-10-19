import { clipboard, BrowserWindow, type IpcMain, type Dialog, type IpcMainInvokeEvent } from 'electron';
import { cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {providerSettingDefinitions, type ReaEngine} from './reaEngine';

export function registerReaWorkbench({ipcMain, dialog, engine, requireTrustedSender}: {
  ipcMain: IpcMain; dialog: Dialog; engine: ReaEngine;
  requireTrustedSender: (event: IpcMainInvokeEvent) => void;
}) {
  const clients = new Map<number, Electron.WebContents>();
  const channels: string[] = [];
  function authorize(event: IpcMainInvokeEvent) {
    requireTrustedSender(event);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('REA requires the main application frame.');
    if (!clients.has(event.sender.id)) {
      clients.set(event.sender.id, event.sender);
      event.sender.once('destroyed', () => clients.delete(event.sender.id));
    }
  }
  function handle(name: string, callback: (event: IpcMainInvokeEvent, input?: any) => any) {
    const channel = `rea-workbench:${name}`;
    channels.push(channel);
    ipcMain.handle(channel, (event, input) => { authorize(event); return callback(event, input); });
  }
  const unsubscribe = engine.onEvent((message) => {
    for (const client of clients.values()) if (!client.isDestroyed()) client.send('rea-workbench:event', message);
  });
  const parent = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender);
  handle('status', () => engine.status());
  handle('connect', () => engine.connect());
  handle('doctor', () => engine.doctor());
  handle('choose-target', async (event, kind) => {
    if (kind !== 'file' && kind !== 'directory') throw new Error('Choose a file or directory.');
    const options = { title: kind === 'file' ? 'Choose REA target' : 'Choose JavaScript / Electron directory', properties: [kind === 'file' ? 'openFile' : 'openDirectory'] as Array<'openFile' | 'openDirectory'> };
    const owner = parent(event);
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return engine.selectTarget(selected.filePaths[0], kind);
  });
  handle('choose-dropped-target', async (_event, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath || targetPath.includes('\0')) throw new Error('Invalid dropped file.');
    return engine.selectTarget(targetPath);
  });
  handle('choose-tool-input', async (event, input) => {
    if (!input || typeof input.name !== 'string' || typeof input.key !== 'string' || !['file', 'directory'].includes(input.kind)) throw new Error('Choose a tool input file or directory.');
    const options = { title: `Choose ${input.key} for ${input.name}`, properties: [input.kind === 'file' ? 'openFile' : 'openDirectory'] as Array<'openFile' | 'openDirectory'> };
    const owner = parent(event);
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return engine.authorizeToolInput(input.name, input.key, selected.filePaths[0], input.kind);
  });
  handle('open-target', (_event, input) => engine.openTarget(input));
  handle('call-tool', (_event, input) => engine.callTool(input));
  handle('cancel', () => engine.cancel());
  handle('reset', () => engine.reset());
  handle('read-artifact', (_event, input) => engine.readArtifact(input));
  handle('list-results', () => engine.listResults());
  handle('read-result', (_event, id) => engine.readResult(id));
  handle('import-results', async (event) => {
    const options = { title: 'Import recovered files for the selected target', properties: ['openDirectory'] as Array<'openDirectory'> };
    const owner = parent(event);
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return engine.importResults(selected.filePaths[0]);
  });
  handle('export-results', async (event, input) => {
    if (input !== undefined && (!input || (input.targetPath !== undefined && typeof input.targetPath !== 'string'))) throw new Error('Choose a Results export scope.');
    const options = { title: 'Choose a folder for the Results export', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const owner = parent(event);
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    const result = await engine.exportResults(input);
    const destination = path.join(selected.filePaths[0], `REA-Results-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await cp(result.path, destination, { recursive: true, force: false, errorOnExist: true });
    return { path: destination, count: result.count };
  });
  handle('mcp-config', () => engine.mcpConfig());
  handle('copy-text', (_event, value) => {if(typeof value !== 'string' || Buffer.byteLength(value) > 2*1024*1024)throw new Error('Clipboard text exceeds the allowed size.');clipboard.writeText(value);});
  handle('provider-settings', () => engine.providerSettings());
  handle('choose-provider-setting', async (event, id) => {
    const setting = providerSettingDefinitions().find(entry => entry.id === id);
    if (!setting) throw new Error('Unknown REA provider setting.');
    const options = {title:`Choose ${setting.label}`, properties:[setting.kind === 'directory' ? 'openDirectory' : 'openFile'] as Array<'openFile'|'openDirectory'>};
    const owner = parent(event);
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return engine.configureProvider(id, selected.filePaths[0]);
  });
  handle('clear-provider-setting', (_event, id) => engine.configureProvider(id));
  handle('preview-dossier', () => engine.exportDossier());
  async function portableReport(result: {path: string; markdown: string}, destination: string) {
    const reportDir = path.dirname(result.path);
    const assets = path.join(path.dirname(destination), `${path.parse(destination).name}.evidence-${randomUUID().slice(0,8)}`);
    await cp(reportDir, assets, {recursive:true, force:false, errorOnExist:true});
    const base = `./${path.basename(assets)}/`;
    let markdown = result.markdown.replaceAll(reportDir + path.sep, base);
    // Rewrite generated relative asset paths for the chosen report location.
    markdown = markdown.replace(/\]\((?:\.\/)?(evidence[^)]*|records\/[^)]*|sources\/[^)]*|results\/[^)]*|archived-evidence\/[^)]*)\)/g, (_match, asset) => `](${base}${asset})`);
    markdown = markdown.replace(/^(Canonical session bundle: |Complete tool record: |Archived session Evidence: )(?!\.\/)(evidence[^\n]*|records\/[^\n]*|archived-evidence\/[^\n]*)$/gm, (_match, label, asset) => `${label}${base}${asset}`);
    return {markdown, assets};
  }
  handle('export-dossier', async (event) => {
    const result = await engine.exportDossier();
    if (!result) return null;
    const owner = parent(event);
    const options = { title: 'Export REA dossier', defaultPath: 'REA-dossier.md', filters: [{name: 'Markdown', extensions: ['md']}] };
    const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (selected.canceled || !selected.filePath) return null;
    const portable = await portableReport(result, selected.filePath);
    await writeFile(selected.filePath, portable.markdown, {mode:0o600});
    return {path:selected.filePath, markdown:portable.markdown, evidenceDirectory:portable.assets};
  });
  handle('export-pdf', async (event) => {
    const result = await engine.exportDossier();
    if (!result) return null;
    const options = {title: 'Export REA dossier as PDF', defaultPath: 'REA-dossier.pdf', filters: [{name: 'PDF', extensions: ['pdf']}]};
    const owner = parent(event);
    const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (selected.canceled || !selected.filePath) return null;
    const portable = await portableReport(result, selected.filePath);
    const escape = (text: string) => text.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
    const printWindow = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try {
      await printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>REA evidence dossier</title><style>body{font:11px monospace;color:#111;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>' + escape(portable.markdown) + '</pre>'));
      await writeFile(selected.filePath, await printWindow.webContents.printToPDF({printBackground:false, pageSize:'A4'}));
      return {path:selected.filePath, evidenceDirectory:portable.assets};
    } finally { printWindow.destroy(); }
  });
  return async () => {
    unsubscribe(); clients.clear();
    for (const channel of channels) ipcMain.removeHandler(channel);
    await engine.dispose();
  };
}
