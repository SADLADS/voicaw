import { useAuth } from './AuthProvider.jsx';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';

import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './components/Dashboard.jsx';
import Plaza from './components/Plaza.jsx';
import Calendar from './components/Calendar.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';

export default function App() {
  const { user, setUser, loading } = useAuth();

  if (loading) return <div>Loading...</div>;

  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={user ? <Navigate to="/dashboard" replace /> : <Login onLoginSuccess={setUser} />}
        />

        {user && (
          <Route element={<Layout user={user} onLogout={() => setUser(null)} />}>
            <Route path="/dashboard" element={<Dashboard user={user} />} />
            <Route path="/plaza" element={<Plaza user={user} />} />
            <Route path="/calendar" element={<Calendar user={user} />} />
            <Route path="/settings" element={<Settings user={user} />} />
            <Route path="/dm/:id?" element={<Dm user={user} />} />
          </Route>
        )}

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}
