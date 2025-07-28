export async function fetchDmMessages(userId) {
    if (!userId) return [];

    try {
        const res = await fetch(`/api/dm-messages/${userId}`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to fetch messages');

        const data = await res.json();
        return data;
    } catch (error) {
        console.error('Error fetching messages:', error);
        throw error;
    }
}

Notification.requestPermission().then(permission => {
    if (permission === 'granted') {
        console.log('Notifications enabled');
    }
});