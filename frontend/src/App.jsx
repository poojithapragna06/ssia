import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Playlists from './pages/Playlists';
import Tasks from './pages/Tasks';
import Alerts from './pages/Alerts';
import Devices from './pages/Devices';
import Users from './pages/Users';
import Instagram from './pages/Instagram';

function AppLayout({ children }) {
  return (
    <div className="app-layout">
      <Navbar />
      <div className="app-body">
        <Sidebar />
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const { loading, isAdmin } = useAuth();

  if (loading) {
    return <div className="page-loading">Loading ScreenSync...</div>;
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Dashboard />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/playlists"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Playlists />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/tasks"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Tasks />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/alerts"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Alerts />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/devices"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Devices />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/users"
        element={
          <ProtectedRoute>
            {/* Admins only; anyone else is sent back to the dashboard */}
            {isAdmin ? (
              <AppLayout>
                <Users />
              </AppLayout>
            ) : (
              <Navigate to="/dashboard" replace />
            )}
          </ProtectedRoute>
        }
      />
      <Route path="/instagram" element={<ProtectedRoute>{isAdmin ? <AppLayout><Instagram /></AppLayout> : <Navigate to="/dashboard" replace />}</ProtectedRoute>} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
