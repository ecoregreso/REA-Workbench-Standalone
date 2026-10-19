const {spawnSync} = require('node:child_process');
const path = require('node:path');
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin' || process.env.SIGNING_REQUESTED === 'true') return;
  if (process.platform !== 'darwin') throw new Error('Build macOS packages on a native Mac runner.');
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  for (const args of [['--force','--deep','--sign','-','--entitlements',path.join(__dirname,'entitlements.mac.plist'),bundle],['--verify','--deep','--strict',bundle]]) {
    const result = spawnSync('/usr/bin/codesign', args, {shell:false,stdio:'inherit'});
    if (result.error || result.status !== 0) throw new Error(`Ad hoc macOS signing failed: ${result.error?.message || result.status}`);
  }
};
