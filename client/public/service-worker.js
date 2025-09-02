self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'New Notification', body: event.data.text() };
  }

  const options = {
    body: data.body,
    icon: '/logo192.png', // Change to user profile pic?
    badge: '/badge.png',
    data: { url: data.url || '/' },
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Notification', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (let client of windowClients) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          client.focus();
          client.postMessage({ action: 'navigate', url: targetUrl });
          return;
        }
      }
      return clients.openWindow(targetUrl);

    })
  );
});