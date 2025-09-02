import React, { useEffect } from 'react';
import api from '../utils/api';
import { connectWebSocket, onNewDm } from '../utils/ws-client';
import notificationSound from '../assets/sounds/notification.mp3';
import logoIcon from '../assets/images/logo.svg';
import { decryptMessage, deriveSharedKey } from '../services/encryptionService';

export default function Settings({ user }) {
  // Request push permission and register subscription
  async function enablePushNotifications() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      alert('Push notifications are not supported in this browser.');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert('Notifications not enabled.');
      return;
    }

    // Register push subscription with service worker
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(user.vapidPubKey),
    });

    await api.post('/api/save-subscription', { subscription });
    alert('Push notifications enabled!');
  }

  // Live in-page notifications via WebSocket
  useEffect(() => {
    if (!user?.id) return;

    connectWebSocket(user.id);

    const unsubscribe = onNewDm(async (message) => {
      // decrypt message
      const sharedKey = await deriveSharedKey(localStorage.getItem('privateKey'), message.public_key);
      const plaintext = await decryptMessage(message.content, sharedKey);

      // Play notification sound
      const audio = new Audio(notificationSound);
      audio.play().catch(() => {});

      // Show in-page notification if permission granted
      if (Notification.permission === 'granted') {
        const notif = new Notification(message.sender_username || 'User', {
          body: plaintext,
          icon: logoIcon,
          silent: true,
        });
        notif.onclick = async () => {
          window.focus();
          await api.post(`/dm-mark-read/${message.sender_id}`);
          window.location.href = `/dm/${message.sender_id}`;
        };
      }
    });

    return () => unsubscribe();
  }, [user?.id]);

  return (
    <div style={{ padding: '2rem' }}>
      <h2>Settings</h2>
      <p>Manage your account and notifications.</p>
      <button onClick={enablePushNotifications}>Enable Push Notifications</button>
    </div>
  );
}

// Helper: convert VAPID key to Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
