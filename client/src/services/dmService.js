export async function fetchUsersList() {
    const res = await fetch('/api/dms-list', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch users');
    return res.json();
}

export async function fetchMessagesForUser(userId) {
    const res = await fetch(`/api/dm-messages/${userId}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch messages');
    return res.json();
}

export async function sendMessageToUser(recipientId, content) {
    const res = await fetch('/api/dm-send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: recipientId, content }),
    });

    if (!res.ok) throw new Error('Failed to send message');
}

export async function markMessagesRead(userId) {
    const res = await fetch(`/api/dm-mark-read/${userId}`, {
        method: 'POST',
        credentials: 'include',
    });

    if (!res.ok) throw new Error('Failed to mark messages as read');
}