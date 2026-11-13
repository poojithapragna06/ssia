import axios from 'axios';

// Built dashboard served by the backend (college PC): same address it was opened from.
// Vite dev server (npm run dev, port 5173): the backend on port 3000 of the same machine.
const IS_DEV_SERVER = window.location.port === '5173';
const API_URL =
  import.meta.env.VITE_API_URL ||
  (IS_DEV_SERVER ? `http://${window.location.hostname}:3000` : window.location.origin);

const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('screensync_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('screensync_token');
      localStorage.removeItem('screensync_user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  register: (payload) => api.post('/auth/register', payload),
  me: () => api.get('/auth/me'),
};

export const playlistApi = {
  list: () => api.get('/getPlaylists'),
  get: (id) => api.get(`/getPlaylist/${id}`),
  create: (payload) => api.post('/createPlaylist', payload),
  update: (id, payload) => api.put(`/updatePlaylist/${id}`, payload),
  remove: (id) => api.delete(`/deletePlaylist/${id}`),
  broadcast: (id) => api.post(`/broadcastPlaylist/${id}`),
  uploadMedia: (file) => {
  const formData = new FormData();
  formData.append('file', file);

  return api.post('/uploadMedia', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
},
};

export const taskApi = {
  listActive: () => api.get('/getTasks'),
  listAll: () => api.get('/getAllTasks'),
  create: (payload) => api.post('/createTask', payload),
  remove: (id) => api.delete(`/deleteTask/${id}`),
};

export const alertApi = {
  listActive: () => api.get('/getAlerts'),
  listAll: () => api.get('/getAllAlerts'),
  push: (payload) => api.post('/pushAlert', payload),
  clear: (id) => api.post(`/clearAlert/${id}`),
  remove: (id) => api.delete(`/deleteAlert/${id}`),
  clearHistory: () => api.delete('/clearAlertHistory'),
};

// Remote control for whatever is playing on the screens
export const playbackApi = {
  get: () => api.get('/playback'),
  // action: pause | resume | next | previous | restart | volume | mute | unmute
  control: (action, extra = {}) => api.post('/playback', { action, ...extra }),
};

export const deviceApi = {
  list: () => api.get('/getDevices'),
};

// Dashboard accounts (admin only)
export const userApi = {
  list: () => api.get('/users'),
  create: (payload) => api.post('/users', payload),
  update: (id, payload) => api.patch(`/users/${id}`, payload),
  remove: (id) => api.delete(`/users/${id}`),
};

export const instagramApi = {
  status: () => api.get('/api/instagram/status'),
  update: (payload) => api.patch('/api/instagram/settings', payload),
  connect: () => api.post('/api/instagram/connect'),
  disconnect: () => api.delete('/api/instagram/connect'),
  sync: (job) => api.post('/api/instagram/sync', { job }),
  media: (status) => api.get('/api/instagram/media', { params: status ? { status } : {} }),
  review: (id, payload) => api.patch(`/api/instagram/media/${id}/review`, payload),
  remove: (id) => api.post(`/api/instagram/media/${id}/remove`),
  history: () => api.get('/api/instagram/history'),
};

export default api;
