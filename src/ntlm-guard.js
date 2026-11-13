// httpntlm follows a Location header the server sends during the NTLM
// handshake, and signs in again wherever it points: another host, or plain
// http. An Exchange server (or whoever answers in its name) could so have
// the sign-in sent elsewhere. Here every request of a handshake must stay on
// the https origin it began on; a redirect anywhere else ends it with an
// error. httpntlm calls its own exported functions when it follows a
// redirect, with the same options object: that is what is watched.

import httpntlm from 'httpntlm';

const began = new WeakMap(); // the options object of a handshake → the origin of its first request

for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options']) {
  const original = httpntlm[method];
  if (typeof original !== 'function' || original.guarded) continue;
  const guarded = function (options, callback) {
    let url;
    try { url = new URL(options.url); } catch { return callback(new Error('EWS: not an address')); }
    const origin = began.get(options);
    if (origin === undefined) began.set(options, url.origin);
    else if (url.protocol !== 'https:' || url.origin !== origin) {
      return callback(Object.assign(new Error(`the server sent the sign-in elsewhere (${url.protocol}//${url.host}): refused`), { code: 'EWS_REDIRECT' }));
    }
    return original.call(this, options, callback);
  };
  guarded.guarded = true;
  httpntlm[method] = guarded;
}

export default httpntlm;
