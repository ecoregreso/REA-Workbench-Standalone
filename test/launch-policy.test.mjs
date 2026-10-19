import test from 'node:test';
import assert from 'node:assert/strict';
import {displayStartupArguments} from '../standalone/launchPolicy.mjs';

test('Linux display choice is passed at executable startup, including mixed Wayland/X11 desktops', () => {
  const environment = {DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland'};
  assert.deepEqual(displayStartupArguments({platform: 'linux', environment}), ['--ozone-platform=x11']);
  for (const args of [['--ozone-platform=wayland'], ['--ozone-platform', 'wayland'], ['--ozone-platform=headless'], ['--ozone-platform=x11']]) {
    assert.deepEqual(displayStartupArguments({platform: 'linux', environment, args}), [], 'Explicit display backends must not be overridden');
  }
});

test('Launch policy does not inject Linux display options into other platforms or display-less sessions', () => {
  for (const platform of ['win32', 'darwin']) assert.deepEqual(displayStartupArguments({platform, environment: {DISPLAY: ':0'}}), []);
  for (const environment of [{}, {DISPLAY: ''}, {DISPLAY: '   '}, {WAYLAND_DISPLAY: 'wayland-0'}]) {
    assert.deepEqual(displayStartupArguments({platform: 'linux', environment}), []);
  }
});
