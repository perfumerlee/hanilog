/* Generic, privacy-safe push handling. Payload content is intentionally ignored. */
/* global self, URL, URLSearchParams */
self.addEventListener('push', (event) => {
  let noticeId = '';
  let petId = '';
  try {
    const payload = event.data ? event.data.json() : {};
    if (typeof payload.notificationId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.notificationId)) noticeId = payload.notificationId;
    if (typeof payload.petId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.petId)) petId = payload.petId;
  } catch { /* Use a generic fallback without exposing raw payload data. */ }
  const target = new URL('./#/notifications', self.registration.scope);
  const query = new URLSearchParams();
  if (petId) query.set('pet', petId);
  if (noticeId) query.set('notification', noticeId);
  const queryString = query.toString();
  target.hash = `/notifications${queryString ? `?${queryString}` : ''}`;
  event.waitUntil(self.registration.showNotification('돌봄 일정 안내', {
    body: 'HaniLog에서 최신 일정을 확인해 주세요.',
    icon: new URL('paw.svg', self.registration.scope).href,
    badge: new URL('paw.svg', self.registration.scope).href,
    tag: noticeId ? `hanilog-${noticeId}` : 'hanilog-care-notice',
    data: { url: target.href },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const candidate = event.notification.data?.url;
  let target;
  try {
    target = new URL(typeof candidate === 'string' ? candidate : './#/notifications', self.registration.scope);
    const scope = new URL(self.registration.scope);
    if (target.origin !== scope.origin || !target.pathname.startsWith(scope.pathname)) target = new URL('./#/notifications', scope);
  } catch { target = new URL('./#/notifications', self.registration.scope); }
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === target.origin) {
        await client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
