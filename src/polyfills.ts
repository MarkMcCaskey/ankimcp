// Polyfill self.location for sql.js asm build in Cloudflare Workers.
// sql.js checks `self.location.href` during module init, which crashes
// in Workers where self.location is undefined.
if (typeof self !== "undefined" && !("location" in self)) {
  Object.defineProperty(self, "location", {
    value: { href: "" },
    writable: true,
    configurable: true,
  });
}
