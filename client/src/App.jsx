import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';

import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './components/Dashboard.jsx';
import Plaza from './components/Plaza.jsx';
import Calendar from './components/Calendar.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';

export default function App() {
  const [user, setUser] = useState(null);

  // On mount, check localStorage for user
  useEffect(() => {
    const savedUser = localStorage.getItem('user');
    if (savedUser) setUser(JSON.parse(savedUser));
  }, []);

  // Save user to localStorage when user state changes
  useEffect(() => {
    if (user) localStorage.setItem('user', JSON.stringify(user));
    else localStorage.removeItem('user');
  }, [user]);

  return (
    <Router>
      <Routes>
        {/* Public login route */}
        <Route
          path="/"
          element={user ? <Navigate to="/dashboard" replace /> : <Login onLoginSuccess={setUser} />}
        />

        {/* Private routes with sidebar layout */}
        {user && (
          <Route element={<Layout user={user} onLogout={() => setUser(null)} />}>
            <Route path="/dashboard" element={<Dashboard user={user} />} />
            <Route path="/plaza" element={<Plaza user={user} />} />
            <Route path="/calendar" element={<Calendar user={user} />} />
            <Route path="/settings" element={<Settings user={user} />} />
            <Route path="/dm/:id?" element={<Dm user={user} />} />
          </Route>
        )}

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}
