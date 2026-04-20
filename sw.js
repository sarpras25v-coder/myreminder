const CACHE_NAME = 'pajaksim-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

// Install
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Activate
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Fetch - cache first
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// --- Notification scheduler ---
// Called by the app periodically via postMessage
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CHECK_DEADLINES') {
    checkAndNotify(e.data.entries);
  }
});

// Push notification (from server - optional)
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'PajakSIM Tracker', {
      body: data.body || 'Ada deadline yang perlu diperhatikan!',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: data.tag || 'pajaksim',
      renotify: true,
      requireInteraction: true,
      data: { url: '/' }
    })
  );
});

// Notification click
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});

// Periodic background sync (if supported)
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-deadlines') {
    e.waitUntil(checkFromStorage());
  }
});

async function checkFromStorage() {
  // Read entries from cache/IDB if available
  // This is a simplified check - main logic is in the app
  const cache = await caches.open(CACHE_NAME);
  // Notify via broadcast
  const allClients = await clients.matchAll();
  allClients.forEach(c => c.postMessage({ type: 'REQUEST_CHECK' }));
}

function checkAndNotify(entries) {
  if (!entries || !Array.isArray(entries)) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  // Check already notified today
  const notifiedKey = 'notified_' + todayStr;

  entries.forEach(entry => {
    const target = new Date(entry.tanggal + 'T00:00:00');
    target.setHours(0, 0, 0, 0);
    const diffMs = target - today;
    const days = Math.round(diffMs / 86400000);

    const thresholds = [30, 14, 7, 3, 1, 0];
    if (!thresholds.includes(days)) return;

    const notifId = `${entry.id}_${days}`;

    // Use tag to avoid duplicate per entry per threshold
    const typeLabel = entry.type === 'pajak' ? '🚙 Pajak Kendaraan' : '🪪 Perpanjangan SIM';
    let title, body, urgency;

    if (days === 0) {
      title = `⚠️ HARI INI! ${typeLabel}`;
      body = `${entry.nama} jatuh tempo HARI INI! Segera urus sekarang.`;
      urgency = 'high';
    } else if (days === 1) {
      title = `🔴 BESOK! ${typeLabel}`;
      body = `${entry.nama} jatuh tempo BESOK (${formatDate(entry.tanggal)}). Jangan sampai terlambat!`;
      urgency = 'high';
    } else if (days <= 3) {
      title = `🔴 ${days} Hari Lagi — ${typeLabel}`;
      body = `${entry.nama} jatuh tempo ${formatDate(entry.tanggal)}. Persiapkan segera!`;
      urgency = 'high';
    } else if (days <= 7) {
      title = `🟡 ${days} Hari Lagi — ${typeLabel}`;
      body = `${entry.nama} jatuh tempo ${formatDate(entry.tanggal)}.`;
      urgency = 'normal';
    } else {
      title = `📅 ${days} Hari Lagi — ${typeLabel}`;
      body = `${entry.nama} jatuh tempo ${formatDate(entry.tanggal)}.`;
      urgency = 'low';
    }

    const actions = [];
    if (days <= 7) {
      actions.push({ action: 'ok', title: 'Lihat Detail' });
    }

    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: notifId,
      renotify: false,
      requireInteraction: days <= 1,
      silent: urgency === 'low',
      vibrate: urgency === 'high' ? [200, 100, 200, 100, 400] : [200, 100, 200],
      actions,
      data: { entryId: entry.id, url: '/' },
      timestamp: Date.now()
    });
  });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
}
