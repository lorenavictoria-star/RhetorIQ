// Fehler in asynchronen Routen (Express 4) an den Fehlerbehandler weitergeben, statt den Prozess zu gefährden (Befund F-08).
// Wirkt wie das Paket express-async-errors: ein abgelehntes Versprechen einer Route ruft next(err) auf.
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncPatched) {
  const orig = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return orig.call(this, req, res, next); // Fehlerbehandler unverändert
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__asyncPatched = true;
}

module.exports = {};
