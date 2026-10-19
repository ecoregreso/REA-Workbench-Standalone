// Ozone is selected before Electron loads the application's main script.
// Keep the X11 choice in the executable argv, and respect explicit backends.
export function displayStartupArguments({platform = process.platform, environment = process.env, args = []} = {}) {
  if (platform !== 'linux' || !environment.DISPLAY?.trim()) return [];
  if (args.some(argument => argument === '--ozone-platform' || argument.startsWith('--ozone-platform='))) return [];
  return ['--ozone-platform=x11'];
}
