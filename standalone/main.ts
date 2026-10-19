import { app, BrowserWindow, ipcMain, dialog, session } from 'electron';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import { ReaEngine } from '../shared/reaEngine';
import { registerReaWorkbench } from '../shared/electron';
// @ts-expect-error Plain JavaScript policy is also exercised directly by Node tests.
import {standaloneProfile, developmentOrigin, allowsRendererRequest} from './isolationPolicy.mjs';

const rawFilesystem = createRequire(__filename)('original-fs').promises;
app.setName('REA Workbench');
app.setPath('userData', standaloneProfile({appData: app.getPath('appData'), isPackaged: app.isPackaged}));
// Keep the native and renderer display backends consistent. Ozone cannot be
// changed here; source launchers pass its switch before this main script runs.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let mainWindow: BrowserWindow | null = null;
  let cleanup: (() => Promise<void>) | undefined;
  let quitting = false;
  if (process.platform === 'linux' && app.commandLine.getSwitchValue('ozone-platform') === 'x11'
      && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')) {
    app.commandLine.appendSwitch('disable-gpu-vsync');
  }
  app.on('second-instance', () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    const entryPath = path.join(app.getAppPath(), '..', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
    // Packaged dependencies live inside the application directory; development uses the workspace root.
    const packagedEntry = path.join(app.getAppPath(), 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
    const engine = new ReaEngine({entryPath: app.isPackaged ? packagedEntry : entryPath,
      runtimePath: process.execPath, filesystem: rawFilesystem, runtimeBootstrapPath: path.join(__dirname, 'runtime.cjs'), environment: {ELECTRON_RUN_AS_NODE: '1'},
      dataDir: path.join(app.getPath('userData'), 'analysis')});
    const devUrl = developmentOrigin({isPackaged: app.isPackaged});
    const indexPath = path.join(__dirname, 'ui', 'index.html');
    const allowed = devUrl ? new URL(devUrl).origin : null;
    cleanup = registerReaWorkbench({ipcMain,dialog,engine,requireTrustedSender: event => {
      if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted REA sender.');
      const url = new URL(event.senderFrame?.url || 'about:blank');
      if (allowed ? url.origin !== allowed : url.href !== pathToFileURL(indexPath).href) throw new Error('Untrusted REA document.');
    }});
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const requestPolicy = {uiDirectory: path.join(__dirname, 'ui'), devOrigin: devUrl};
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({cancel: !allowsRendererRequest(details.url, requestPolicy)});
    });
    session.defaultSession.on('will-download', event => event.preventDefault());
    mainWindow = new BrowserWindow({width: 1600,height: 1000,minWidth: 880,minHeight: 640,
      title: 'REA Workbench', backgroundColor: '#101315',autoHideMenuBar: true,
      webPreferences: {preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true}});
    mainWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    mainWindow.webContents.on('will-navigate', event => event.preventDefault());
    mainWindow.on('closed', () => {mainWindow = null;});
    if (devUrl) await mainWindow.loadURL(devUrl); else await mainWindow.loadFile(indexPath);
  }).catch(error => {dialog.showErrorBox('REA Workbench could not start', error.message); app.quit();});
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => app.quit());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !cleanup) return;
    event.preventDefault(); quitting = true;
    void cleanup().finally(() => app.quit());
  });
}
