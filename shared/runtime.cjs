// Disable Electron's archive virtualization only inside this owned REA child.
// The desktop host uses original-fs instead; its application archive remains intact.
process.noAsar = true;
const {isAbsolute} = require('node:path');
const {pathToFileURL} = require('node:url');
const [entry, ...args] = process.argv.slice(2);
if (!entry || !isAbsolute(entry)) {
  process.stderr.write('REA requires an absolute engine entry path.\n');
  process.exit(1);
}
process.argv = [process.argv[0], entry, ...args];
import(pathToFileURL(entry).href).catch(error => {
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exitCode = 1;
});
