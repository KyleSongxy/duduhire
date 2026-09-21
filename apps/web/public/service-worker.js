// Retire the previous site's worker at its existing URL. DuduHire does not
// register a worker; this only updates browsers that still have Fangxu installed.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Only remove the cache observed on the site being replaced.
    await caches.delete("fangxu-shell-v2");
    await self.clients.claim();
    await self.registration.unregister();
  })());
});

// No fetch handler: requests use the network, including existing controlled tabs.
