import React, { useEffect, useState } from 'react';

export default function Dm({ user }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchUsers() {
      try {
        setLoading(true);
        const res = await fetch(`/api/dms-list?userId=${user.id}`);
        if (!res.ok) throw new Error('Failed to fetch users');
        const data = await res.json();
        setUsers(data);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    fetchUsers();
  }, [user.id]);

  if (loading) return <p>Loading users...</p>;
  if (error) return <p>Error: {error}</p>;

  return (
    <div>
      <h2>Direct Messages</h2>
      <ul>
        {users.map(({ id, username, last_timestamp }) => (
          <li key={id}>
            {username} {last_timestamp && <small>({new Date(last_timestamp).toLocaleString()})</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}
