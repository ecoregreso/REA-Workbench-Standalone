import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function standaloneProfile({appData, isPackaged, environment = process.env}) {
  const override = !isPackaged && environment.REA_WORKBENCH_USER_DATA;
  return override ? path.resolve(override) : path.join(appData, 'REA Workbench');
}

export function developmentOrigin({isPackaged, environment = process.env}) {
  const value = !isPackaged && environment.REA_WORKBENCH_DEV_URL;
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Development UI must use a loopback HTTP origin with an explicit port.');
  }
  return url.origin;
}

export function allowsRendererRequest(value, {uiDirectory, devOrigin}) {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      if (devOrigin || url.hostname) return false;
      const relative = path.relative(uiDirectory, fileURLToPath(url));
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }
    if (url.protocol === 'data:') return true;
    if (!devOrigin || url.username || url.password) return false;
    const origin = new URL(devOrigin);
    return (url.protocol === 'http:' || url.protocol === 'ws:') && url.hostname === origin.hostname && url.port === origin.port;
  } catch { return false; }
}
