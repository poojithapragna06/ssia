# ScreenSync

Real-time synchronization and centralized management for multiple digital displays.

ScreenSync lets an administrator manage playlists, scheduled tasks, and emergency
alerts from a single dashboard and push them, over WebSockets, to every connected
TV in real time — regardless of whether that TV is on a fast LAN connection or a
flakier Wi-Fi connection.

---

## 1. Overview

Two reference devices are modeled out of the box:

| Device | Connection | Role |
|---|---|---|
| Sony FW-65BZ30L | LAN | Reference display — assumed low-latency, starts playback exactly at the sync timestamp |
| Samsung QM65C | Wi-Fi | Buffered display — preloads content and compensates for latency/jitter using timestamp math |

Both are plain browser clients (no proprietary Sony/Samsung SDKs). Any device that
can open a Chromium-based browser can register as a new display without changing
the backend or frontend.

## 2. Architecture

```
React Admin UI  ──REST + JWT──▶  Node.js/Express Backend  ──▶  MongoDB
                                          │
                                     WebSocket (ws)
                                          │
                        ┌─────────────────┴─────────────────┐
                        ▼                                     ▼
                 Sony LAN TV client                  Samsung Wi-Fi TV client
                 (reference clock)                    (buffered playback)
```

The same WebSocket server also pushes live device-status updates to any admin
dashboard connected to it, so the Devices/Dashboard pages update without polling.

## 3. Technology Stack

**Backend:** Node.js, Express.js, MongoDB + Mongoose, `ws`, JWT, bcryptjs, dotenv, cors
**Frontend:** React 18, React Router, Axios, native WebSocket API, Vite
**TV Clients:** Plain HTML/CSS/JavaScript, native WebSocket API

## 4. Project Structure

```
screensync/
├── backend/
│   └── src/
│       ├── config/db.js
│       ├── models/{User,Playlist,Task,Alert}.js
│       ├── controllers/{auth,playlist,task,alert,device}Controller.js
│       ├── routes/{auth,playlist,task,alert,device}Routes.js
│       ├── middleware/{authMiddleware,errorHandler}.js
│       ├── services/{websocketService,priorityService}.js
│       ├── utils/{constants,asyncHandler}.js
│       └── server.js
├── frontend/
│   └── src/
│       ├── components/{Navbar,Sidebar,PlaylistCard,TaskCard,DeviceCard,AlertBanner,ProtectedRoute}.jsx
│       ├── pages/{Login,Dashboard,Playlists,Tasks,Alerts,Devices}.jsx
│       ├── services/{api,websocket}.js
│       ├── context/AuthContext.jsx
│       ├── App.jsx, main.jsx, index.css
├── tv-client/
│   ├── lan-tv/  (index.html, app.js, style.css)
│   └── wifi-tv/ (index.html, app.js, style.css)
└── README.md
```

## Running ScreenSync in the department

In the department, one Windows PC runs ScreenSync and every TV opens a page from
it over the college network. That PC serves **everything on port 3000**: the
dashboard, both TV pages and the API.

| What | Address |
|---|---|
| Dashboard (staff) | `http://<pc-name>:3000/` |
| LAN TV page (Sony BRAVIA, wired) | `http://<pc-name>:3000/tv/lan/?kiosk=1&id=<screen-name>` |
| Wi-Fi TV page (Samsung QM, Wi-Fi) | `http://<pc-name>:3000/tv/wifi/?kiosk=1&id=<screen-name>` |

`<pc-name>` is the ScreenSync PC's computer name (shown when ScreenSync starts,
e.g. `dept-pc`). `<screen-name>` is any short unique name per TV, e.g.
`corridor_tv` or `lab2_tv`. `kiosk=1` hides the status strip.

**Use the PC's name, not its IP address.** YouTube refuses to play some videos
(often ones with copyrighted music) on pages opened by an IP address such as
`http://172.22.20.118:3000`, showing *"the owner of this video does not allow it
to be played outside YouTube"* — yet plays them when the same page is opened by
name. A name also keeps working if the PC's IP address changes. If a TV can't
find the PC by name, use the IP address: TV pages and the dashboard opened by IP
switch to the name by themselves as soon as they can reach it. If the TVs can't
resolve Windows computer names, ask the college IT admin to add a DNS name for
the PC (e.g. `screensync.<college-domain>`).

### 1. The ScreenSync PC (once)

1. Install **Node.js LTS** (nodejs.org) and **MongoDB Community Server**
   (choose "Install as a Service"). In *Services*, set **MongoDB** to
   *Automatic* so it starts with Windows.
2. Copy the project folder to the PC.
3. Give the PC a short, simple name (Settings → System → About → **Rename this
   PC**, e.g. `dept-pc`). Ask the college IT/network admin to make sure the TVs
   can reach it — some college Wi-Fi blocks devices from talking to each other —
   and, if possible, to reserve a fixed IP address for it as a fallback.
4. Allow ScreenSync through Windows Firewall (PowerShell **as Administrator**):

   ```powershell
   New-NetFirewallRule -DisplayName "ScreenSync" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
   ```
5. Double-click **`start-screensync.bat`**. The first run installs packages,
   creates `backend\.env` with a random `JWT_SECRET`, builds the dashboard and
   starts the server. The window lists the exact dashboard and TV addresses.
6. Create the first admin: in another window, `cd backend` and run
   `npm run create-user`. Then open the dashboard and add other staff under
   **Users**.
7. Start ScreenSync with Windows: press `Win + R`, type `shell:startup`, and put
   a **shortcut** to `start-screensync.bat` in that folder. Also set the PC to
   never sleep (Settings → System → Power) and to sign in automatically, or
   leave it signed in.

Keep the window open — closing it stops ScreenSync. If the server ever stops
by itself, the script starts it again after 5 seconds.

### 2. Each TV (once)

Both TV models can open a web page full screen whenever they switch on — no
PC, stick or remote clicks needed. Menu names differ by firmware; check the
TV's manual if they don't match exactly.

- **Samsung QM series (Tizen signage):** Home → **URL Launcher** (or
  Settings → Support/System → URL Launcher Settings) → enter the Wi-Fi TV page
  address → set it as the default content / start on power-on.
- **Sony BRAVIA BZ series (Pro display):** enable **Pro mode** (Pro Settings),
  then set the **content launcher / start-up URL** (HTML5 browser) to the LAN TV
  page address, and turn on launching it at start-up.

Give every TV a different `id=`. TVs appear on the dashboard's **Devices**
page as they connect. When a TV switches on or reconnects, it immediately gets
the current playlist, alerts and tasks.

**Sound:** signage launchers normally allow video to play with sound on their
own. If a TV shows the note *"Click anywhere for full screen and sound"*, its
browser keeps sound off until someone interacts with it once (the remote's OK
button usually works).

**A TV without a launcher** (or a normal TV): connect a small PC and run
`tv-client\launch-tv.bat`, using the address above, or open the page in its
browser.

### Updating ScreenSync later

Copy the new project files to the PC (keep `backend\.env` and `backend\uploads`),
then close the ScreenSync window and run `start-screensync.bat` again — it
rebuilds the dashboard. Reload the TV pages (or switch the TVs off and on).

## 5. Prerequisites

* Node.js 20+ (required by the AWS JavaScript SDK used for persistent Instagram media storage)
* MongoDB running locally (or a connection string to a remote instance)
* A modern browser (Chrome/Edge/Firefox) for the admin UI and TV clients

## 6. MongoDB Setup

Start a local MongoDB instance, e.g.:

```bash
mongod --dbpath /path/to/your/data
```

The backend will create the `screensync` database and its collections automatically
on first write — no manual schema setup is required.

## 7. Backend Setup

```bash
cd backend
cp .env.example .env    # edit JWT_SECRET and MONGODB_URI as needed
npm install
npm run dev              # nodemon, auto-restarts on change
# or: npm start
```

The API and WebSocket server both run on the same port (`PORT`, default `3000`).

### User accounts

ScreenSync has no public sign-up: only people an admin adds can sign in.

**First admin** (fresh database) — from the `backend` folder run:

```bash
npm run create-user
```

and answer the questions (name, email, role, password). It writes straight to
the database in `MONGODB_URI`, so for a deployed site you can run it from your
own laptop with `backend/.env` pointing at the online database. If the email
already exists it offers to reset that user's password and role — the way back
in if the admin password is ever lost.

**Everyone else** — sign in as an admin and open **Users** in the sidebar to add
people (admin or viewer), reset passwords, change roles or remove accounts.

| Role | Can do |
|---|---|
| `admin` | Everything: playlists, tasks, alerts, playback control, users |
| `viewer` | See everything, change nothing |

`POST /auth/register` only works while the database has no users (it then
creates that first account as an admin); after that it is closed.

## 8. Frontend Setup

```bash
cd frontend
cp .env.example .env      # point at your backend if not localhost:3000
npm install
npm run dev                # Vite dev server on http://localhost:5173
```

Log in with the admin account you registered above.

## 9. TV Client Setup

The TV clients are static files — no build step required. Serve each folder with
any static file server and open it in a browser (or on the TV itself, in kiosk
mode):

```bash
# from the tv-client directory
npx serve lan-tv -l 8081
npx serve wifi-tv -l 8082
```

Then open `http://localhost:8081` (Sony/LAN) and `http://localhost:8082`
(Samsung/Wi-Fi) — or load them on the actual TVs' browsers, pointed at your
backend's LAN IP.

### Starting a screen with no clicks (recommended)

Content always starts by itself, but browsers keep **sound** off until someone
clicks the page. On each Windows laptop/PC used as a screen, run
`tv-client\launch-tv.bat` instead of opening the page by hand:

```
launch-tv.bat 192.168.1.10 wifi canteen_tv
```

(or double-click it and answer the questions). It opens Chrome (or Edge) full
screen in kiosk mode with autoplay allowed, so video **and** sound start on their
own and everything is controlled from the dashboard. Close it with `Alt+F4`.

Opened without the launcher, a screen still plays everything muted and shows a
small "Sound off" note; one click anywhere on it turns the sound on.

### YouTube videos

YouTube items play through YouTube's IFrame Player API. Every few seconds each
screen compares the video's position with the shared timeline and corrects it
if it has drifted by more than 1.5 s, so all screens stay on the same second.

Some videos can't be played outside youtube.com — usually because the owner has
disabled embedding (common for videos containing copyrighted music). The
dashboard checks this when a link is pasted and refuses to save such a video;
if it happens on a screen anyway, the screen shows a message instead of
YouTube's "Watch on YouTube" link. Use another video or upload the file instead.

### Adding more screens

Any number of screens can join. Open the LAN page (`:8081`, reference playback)
or the Wi-Fi page (`:8082`, buffered playback) on each device. Every screen gets
its own device ID automatically (e.g. `wifi_tv_k3x9qa`, saved in that browser),
shown in the top-left status bar and on the dashboard's Devices page.

To give a screen a readable name, add `?id=` to the URL:

```
http://<laptop-ip>:8081/?id=lobby_tv
http://<laptop-ip>:8082/?id=canteen_tv
```

Use a different `id` for each screen; two screens with the same ID will replace
each other. Two tabs in the same browser share the saved ID, so give them
different `?id=` values.

By default each client connects to port `3000` on the machine that served the
page (`ws://<page-host>:3000`). To point at a different
backend, set `window.SCREENSYNC_WS_URL` before `app.js` loads, e.g. add this to
`index.html` above the `<script src="app.js">` tag:

```html
<script>window.SCREENSYNC_WS_URL = 'ws://192.168.1.50:3000';</script>
```

## 10. Environment Configuration

**backend/.env**
```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/screensync
JWT_SECRET=replace_with_secure_secret
JWT_EXPIRES_IN=24h
HEARTBEAT_TIMEOUT_MS=30000
HEARTBEAT_INTERVAL_MS=10000
SYNC_BUFFER_MS=2000
CORS_ORIGIN=http://localhost:5173
```

**frontend/.env**
```env
VITE_API_URL=http://localhost:3000
VITE_WS_URL=ws://localhost:3000
```

Never commit real secrets — `.env` is for local values only, `.env.example` is
checked in as a template.

## 11. Authentication

JWT-based auth with three roles: `admin`, `viewer`, `tv`.

* `POST /auth/register` — create a user (defaults to `viewer` if no role given)
* `POST /auth/login` — returns `{ user, token }`
* `GET /auth/me` — returns the authenticated user (requires `Authorization: Bearer <token>`)

Only `admin` users can create/update/delete playlists, tasks, and alerts.
`viewer` users can read dashboards but not modify content. `tv` is reserved for
device-identity tokens if you choose to authenticate TV WebSocket connections
with JWTs in the future — the current TV registration flow authenticates by
`device_id` at the WebSocket layer instead.

## 12. REST APIs

All responses follow:
```json
{ "success": true, "message": "...", "data": {} }
{ "success": false, "message": "...", "errors": [] }
```

### Playlists
```
GET    /getPlaylists
GET    /getPlaylist/:playlistId
POST   /createPlaylist                 (admin)
PUT    /updatePlaylist/:playlistId     (admin)
DELETE /deletePlaylist/:playlistId     (admin)
POST   /broadcastPlaylist/:playlistId  (admin) — pushes the playlist to all connected TVs
```

Example payload:
```json
{
  "name": "Morning Schedule",
  "items": [
    { "media_type": "image", "url": "https://example.com/image.jpg", "duration": 10 },
    { "media_type": "video", "url": "https://example.com/video.mp4", "duration": 30 },
    { "media_type": "text", "content": "Welcome to ScreenSync", "duration": 8 }
  ]
}
```

```bash
curl -X POST http://localhost:3000/createPlaylist \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Morning Schedule","items":[{"media_type":"text","content":"Hello","duration":5}]}'
```

### Tasks
```
GET  /getTasks       — active tasks only, sorted by priority desc
GET  /getAllTasks     — all tasks (admin UI listing)
POST /createTask      (admin)
DELETE /deleteTask/:taskId (admin)
```

```json
{
  "title": "Important Announcement",
  "content": "Meeting starts at 2 PM",
  "priority": 3,
  "schedule": { "start": "2026-09-01T12:00:00.000Z", "end": "2026-09-01T14:00:00.000Z" }
}
```
Priority: `1=Low, 2=Medium, 3=High, 4=Emergency`.

### Alerts
```
GET  /getAlerts       — active, non-expired alerts
GET  /getAllAlerts     — full history
POST /pushAlert        (admin)
POST /clearAlert/:alertId (admin)
```

```json
{ "message": "Emergency evacuation required.", "priority": 4, "expires": "2026-09-01T13:00:00.000Z" }
```

### Devices
```
GET /getDevices — live snapshot of registered TVs and their status
```

## 13. WebSocket Protocol

All clients connect to `ws://<host>:<port>` and speak newline-delimited JSON
messages of the form `{ "type": "...", ...fields }`.

### TV registration
```json
{ "type": "register", "device_id": "sony_lan_tv_01", "device_type": "tv", "network": "LAN", "role": "reference" }
{ "type": "register", "device_id": "samsung_wifi_tv_01", "device_type": "tv", "network": "WiFi", "role": "buffered" }
```

### Admin dashboard registration (for live device-status updates)
```json
{ "type": "register", "device_type": "admin", "token": "<JWT>" }
```

### Heartbeat (sent every `HEARTBEAT_INTERVAL_MS` by TV clients)
```json
{ "type": "heartbeat", "device_id": "sony_lan_tv_01", "status": "online", "last_sync": "2026-09-01T12:00:05.000Z", "network": "LAN" }
```
A device is marked offline if no heartbeat arrives within `HEARTBEAT_TIMEOUT_MS`.

### Server → TV pushes
```json
{ "type": "playlist", "playlist_id": "...", "name": "Morning Schedule", "items": [...], "sync_timestamp": "..." }
{ "type": "task", "task_id": "...", "title": "...", "content": "...", "priority": 3, "schedule": {...}, "media": {...} }
{ "type": "clear_task", "task_id": "..." }
{ "type": "alert", "alert_id": "...", "message": "...", "priority": 4, "expires": "..." }
{ "type": "clear_alert", "alert_id": "..." }
{ "type": "reset_schedule" }
```

When a TV registers (switching on, refreshing, or reconnecting after a network
drop) the server sends `playback`, the active `playlist`, then `reset_schedule`
followed by every active `alert` and every `task` that hasn't ended yet
(including ones scheduled for later). So a screen switched on in the morning
still shows alerts and tasks created before it was on.

```json
{ "type": "device_list", "devices": [ ... ] }   (admin channel only)
{ "type": "ack", "message": "..." }
{ "type": "error", "message": "..." }
```

The backend exposes these functions internally (`services/websocketService.js`):
`broadcast(message)`, `broadcastToTVs(message)`, `sendToDevice(deviceId, message)`,
`removeClient(deviceId)`. Dead connections are detected via ping/pong and
terminated; TVs reconnect automatically with exponential backoff (capped at 15s).

## 14. Synchronization Mechanism

When an admin broadcasts a playlist, the backend computes
`sync_timestamp = now + SYNC_BUFFER_MS` and sends it to every TV.

* **Sony (LAN, reference):** waits until `sync_timestamp`, then starts from item 0.
* **Samsung (Wi-Fi, buffered):** preloads/warms the browser cache for playlist
  media immediately, then also waits until `sync_timestamp`. If the message
  arrives **after** `sync_timestamp` has already passed (late delivery due to
  Wi-Fi latency), it calculates the correct in-progress item and offset —
  `computePlaybackPosition()` in `tv-client/wifi-tv/app.js` — and resumes
  mid-sequence instead of restarting from the beginning.

All timestamps are ISO 8601, generated server-side, so client clock skew doesn't
affect the reference point.

> **This is best-effort synchronization.** Browser rendering, video decode
> startup, and network jitter all introduce sub-second variance. This system
> does not provide hardware-level, frame-accurate synchronization — it keeps
> independent browser clients closely aligned, which is sufficient for digital
> signage but not for applications requiring frame-perfect sync (e.g. video walls).

## 15. Priority System

Every TV client exposes `resolveActiveContent()`, which returns the
highest-priority content that should be on screen right now:

```
Emergency Alert  >  High Task  >  Medium Task  >  Low Task  >  Normal Playlist
```

Alerts and tasks are pruned client-side once expired; when the last active
alert/task disappears, `resolveActiveContent()` automatically falls back to
the next-highest priority content, ultimately resuming the standing playlist.

## 16. Instagram automation (disabled by default)

The admin-only **Instagram** page is a preparation layer for Meta's official
Instagram Graph API. Instagram settings are stored separately from playlists;
the existing playlist and TV clients continue to work when Instagram is not
connected. Imported post IDs are unique, tokens are encrypted with AES-256-GCM,
and automation starts disabled. The OAuth flow only accepts a linked Instagram
professional account exposed through an authorized Facebook Page.

### Media, OCR and carousel processing

Meta discovery, token storage, admin settings, media download, OCR, carousel
processing, and GitHub Actions triggers are implemented. Each feed post is
deduplicated by Instagram ID. Carousel children are downloaded in Meta's order
and become consecutive playlist slides. Media bytes are stored in a private
S3-compatible bucket; TVs stream them through ScreenSync and never receive
bucket credentials or Meta's expiring media URLs. Render's local filesystem is
not used for Instagram media.

Tesseract OCR extracts text from every imported image slide. A conservative
date parser distinguishes event dates from registration deadlines and offer
expiry dates. Only a clearly labeled, unambiguous event date is automatically
approved. Uncertain dates remain in the admin review queue, so uncertain OCR
cannot trigger removal. Date-only event dates use Asia/Kolkata, and removal
occurs after seven full IST days. Stories expire independently at the Meta
timestamp plus 24 hours. Videos are stored and played but do not undergo OCR.
Story and feed availability depends on the Meta app permissions and API
responses. Tesseract language data must be downloadable by Render on its first
OCR run.

### Configuration and later activation

Copy `backend/.env.example` to `backend/.env` (or set these values in Render).
The required Instagram values are `META_APP_ID`, `META_APP_SECRET`,
`META_REDIRECT_URI`, `META_GRAPH_VERSION`, `META_OAUTH_SCOPES`,
`INSTAGRAM_TOKEN_ENCRYPTION_KEY`, `INSTAGRAM_SCHEDULER_SECRET`,
`INSTAGRAM_OBJECT_STORAGE_BUCKET`, `INSTAGRAM_OBJECT_STORAGE_REGION`, and
`FRONTEND_BASE_URL`. For AWS S3, configure credentials through the AWS SDK
credential chain (prefer a Render IAM role where available). For an S3-compatible
provider also set `INSTAGRAM_OBJECT_STORAGE_ENDPOINT` and, if needed,
`INSTAGRAM_OBJECT_STORAGE_FORCE_PATH_STYLE=true`. `TESSERACT_LANGUAGES` accepts
Tesseract language codes and defaults to `eng`. Use long, random, different
secrets for token encryption and scheduler authentication. Back up the
encryption key securely; losing it makes stored Meta tokens unreadable.
Automation remains disabled by default.

In the Meta developer console, configure the exact redirect URI above and obtain
the permissions required for the college's professional account. Configure the
Meta app ID/secret and the key values in Render's environment settings, then
deploy. Sign in as a ScreenSync admin, open **Instagram**, and use **Connect
Instagram** to authorize a linked professional account. Verify the account and
permissions before enabling sync. Create a private S3 bucket and grant the
Render service read/write access before enabling feed or story sync.

### GitHub Actions scheduling

The `.github/workflows/instagram-*.yml` workflows use UTC cron schedules: feed
daily at 02:17 UTC, stories every six hours at minute 23, and expiry daily at
03:41 UTC. In the repository's **Settings → Secrets and variables → Actions**,
add `SCREENSYNC_URL` (the Render base URL without a trailing slash) and
`INSTAGRAM_SCHEDULER_SECRET` (the same secret configured in Render). Workflow
concurrency groups prevent overlapping executions of the same workflow, and
the event-expiry endpoint also uses a database lease. Jobs retry transient HTTP
errors and write sync history to MongoDB.

The three Instagram Actions can be manually dispatched for operations. Normal
playlist creation, editing, deletion, WebSocket broadcasts, and TV playback
continue to use the existing ScreenSync APIs and shared TV client.

## 17. Testing Instructions

### Authentication
```bash
# Valid login
curl -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"<your-admin-email>","password":"<your-password>"}'

# Invalid login
curl -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"<your-admin-email>","password":"wrong"}'
# -> 401

# Unauthorized request (no token)
curl http://localhost:3000/getPlaylists
# -> 401

# Viewer attempting an admin operation
curl -X POST http://localhost:3000/createPlaylist -H "Authorization: Bearer <VIEWER_TOKEN>" \
  -H "Content-Type: application/json" -d '{"name":"x","items":[{"media_type":"text","content":"x","duration":5}]}'
# -> 403
```

### Playlists
* Create via `POST /createPlaylist`, confirm `201` and the doc in `GET /getPlaylists`.
* Update via `PUT /updatePlaylist/:id`, confirm fields changed.
* Delete via `DELETE /deletePlaylist/:id`, confirm `404` on subsequent `GET`.
* Submit an item missing `duration` or an invalid `media_type` → expect `400` with validation errors.
* Broadcast via `POST /broadcastPlaylist/:id` with two TV clients connected — both should render the new content at (approximately) the same wall-clock moment.

### Tasks
* Create tasks with priorities 1–4, confirm `GET /getTasks` returns only those whose schedule window includes "now", sorted descending by priority.
* Create a task with an `end` time in the past — confirm it does **not** appear in `GET /getTasks` (but does appear in `GET /getAllTasks`).

### Alerts
* `POST /pushAlert` with a short `expires` window; confirm connected TVs immediately show the red alert overlay, overriding any task/playlist.
* Wait past `expires` (or call `POST /clearAlert/:id`); confirm the TV falls back to the next-highest-priority content within one priority-check cycle (~5s).

### WebSockets
* Open both `tv-client/lan-tv` and `tv-client/wifi-tv` in separate tabs; confirm both appear in `GET /getDevices` and on the Devices page with `status: online`.
* Kill one tab's network (DevTools → offline) and confirm it flips to `offline` in the dashboard within `HEARTBEAT_TIMEOUT_MS`.
* Reconnect it and confirm it re-registers and returns to `online`.
* Send a malformed message manually (e.g. via browser console `socket.send("not json")`) and confirm the server responds with a `type: "error"` message rather than crashing.

---

Built as a modular, horizontally-extensible signage platform — adding a third,
fourth, or Nth display only requires pointing a new browser client at the same
WebSocket endpoint with a unique `device_id`; no backend or frontend changes
are required.
