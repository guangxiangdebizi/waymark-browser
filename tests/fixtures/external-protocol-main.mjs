import { app } from 'electron';

// Exercise Chromium's real permission events without registering a protocol or starting an OS app.
globalThis.externalDecisions = [];
app.getApplicationNameForProtocol = url => url.startsWith('waymark-test:') ? 'Test handler' : '';
app.on('session-created', ses => {
  const install = ses.setPermissionRequestHandler.bind(ses);
  ses.setPermissionRequestHandler = handler => install((contents, permission, callback, details) => {
    if (permission !== 'openExternal') return handler(contents, permission, callback, details);
    handler(contents, permission, allow => {
      globalThis.externalDecisions.push([details.externalURL, allow]);
      callback(false);
    }, details);
  });
});
await import('../../dist/app/electron-main.js');
