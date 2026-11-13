import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const links = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/devices', label: 'Devices' },
  { to: '/users', label: 'Users', adminOnly: true },
  { to: '/instagram', label: 'Instagram', adminOnly: true },
];

export default function Sidebar() {
  const { isAdmin } = useAuth();

  return (
    <nav className="sidebar">
      {links.filter((link) => !link.adminOnly || isAdmin).map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}
