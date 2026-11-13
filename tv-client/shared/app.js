/*
 * ScreenSync - Sony FW-65BZ30L (LAN) TV Client
 *
 * Reference display.
 *
 * Playback is synchronized using the playlist's global sync_timestamp.
 *
 * Browser/WebSocket synchronization is BEST-EFFORT.
 * It does not provide hardware-level frame synchronization.
 */

// ============================================================
// DEVICE ID
// ============================================================
// Every screen needs its own device ID, otherwise screens kick each other off.
// Priority: ?id=... in the URL > ID saved on this device > newly generated one.

function getDeviceId(prefix) {

  const fromUrl =
    new URLSearchParams(window.location.search).get('id');

  if (fromUrl) {
    return fromUrl.trim().replace(/[^\w-]/g, '_');
  }

  const key = 'screensync_device_id';

  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
  } catch (e) { /* storage blocked - fall through */ }

  const generated =
    `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    localStorage.setItem(key, generated);
  } catch (e) { /* not persisted */ }

  return generated;
}


// Where the backend is. Opened from the backend itself (college PC, e.g.
// http://<pc>:3000/tv/wifi/): that same address. Served on their own
// (npx serve on 8081 / 8082): port 3000 of the same machine.
function defaultWsUrl() {
  const { protocol, hostname, host, port } = window.location;
  if (!hostname) return 'ws://localhost:3000';
  const scheme = protocol === 'https:' ? 'wss' : 'ws';
  return port === '8081' || port === '8082' ? scheme + '://' + hostname + ':3000' : scheme + '://' + host;
}

// Identifies this page (this tab) to the server, separately from its name:
// the same page reconnecting replaces its old connection, while a different
// screen that happens to use the same name gets its own (e.g. lab_tv_2).
// sessionStorage: kept across reloads of this tab, different for every tab.
function getInstanceId() {
  const key = 'screensync_instance_id';
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
  } catch (e) { /* storage blocked - fall through */ }
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  try { sessionStorage.setItem(key, id); } catch (e) { /* not kept */ }
  return id;
}
const INSTANCE_ID = getInstanceId();

// One shared TV page; the URL selects the screen's network/playback profile.
const TV_MODE =
  new URLSearchParams(window.location.search).get('mode')?.toLowerCase() === 'wifi'
    ? 'wifi'
    : 'lan';

const CONFIG = {
  WS_URL: window.SCREENSYNC_WS_URL || defaultWsUrl(),

  DEVICE_ID: getDeviceId(TV_MODE === 'wifi' ? 'wifi_tv' : 'lan_tv'),

  NETWORK: TV_MODE === 'wifi' ? 'WiFi' : 'LAN',

  ROLE: TV_MODE === 'wifi' ? 'buffered' : 'reference',

  HEARTBEAT_INTERVAL_MS: 10000,

  RECONNECT_BASE_MS: 1000,

  RECONNECT_MAX_MS: 15000,
};


// ============================================================
// STATE
// ============================================================

// Show this screen's ID in the status bar (the ID listed on the dashboard's Devices page)
function showDeviceLabel() {
  document.getElementById('device-label').textContent =
    `${CONFIG.DEVICE_ID} (${CONFIG.NETWORK} / ${CONFIG.ROLE})`;
}
showDeviceLabel();


const state = {
  socket: null,

  reconnectAttempt: 0,

  reconnectTimer: null,

  connected: false,

  playlist: null,

  tasks: new Map(),

  alerts: new Map(),

  playlistTimer: null,

  playlistIndex: 0,

  priorityCheckTimer: null,

  // Wi-Fi mode warms image/video resources before their scheduled playback.
  preloadedUrls: new Set(),
};


// ============================================================
// DOM ELEMENTS
// ============================================================

const els = {
  status: document.getElementById('connection-status'),

  bufferStatus: document.getElementById('buffer-status'),

  contentRoot:
    document.getElementById('content-root'),

  alertOverlay:
    document.getElementById('alert-overlay'),

  alertMessage:
    document.getElementById('alert-message'),
};


// ============================================================
// CONNECTION STATUS
// ============================================================

function setConnectionStatus(isOnline) {
  state.connected = isOnline;

  els.status.textContent = isOnline
    ? 'online'
    : 'reconnecting...';

  els.status.className = isOnline
    ? 'online'
    : 'offline';
}


// ============================================================
// SEND MESSAGE
// ============================================================

function send(payload) {
  if (
    state.socket &&
    state.socket.readyState === WebSocket.OPEN
  ) {
    state.socket.send(
      JSON.stringify(payload)
    );
  }
}


// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

function connect() {

  // ----------------------------------------------------------
  // Prevent duplicate connections
  // ----------------------------------------------------------

  if (
    state.socket &&
    (
      state.socket.readyState === WebSocket.OPEN ||
      state.socket.readyState === WebSocket.CONNECTING
    )
  ) {
    console.log(
      '[WebSocket] Connection already active'
    );

    return;
  }

  console.log(
    '[WebSocket] Connecting to:',
    CONFIG.WS_URL
  );

  const socket =
    new WebSocket(CONFIG.WS_URL);

  state.socket = socket;


  // ----------------------------------------------------------
  // OPEN
  // ----------------------------------------------------------

  socket.addEventListener(
    'open',
    () => {

      console.log(
        '[WebSocket] Connected'
      );

      state.reconnectAttempt = 0;

      // Cancel pending reconnect timer
      if (state.reconnectTimer) {
        clearTimeout(
          state.reconnectTimer
        );

        state.reconnectTimer = null;
      }

      setConnectionStatus(true);


      // ------------------------------------------------------
      // Register this TV
      // ------------------------------------------------------

      send({
        type: 'register',

        device_id:
          CONFIG.DEVICE_ID,

        instance_id:
          INSTANCE_ID,

        device_type:
          'tv',

        network:
          CONFIG.NETWORK,

        role:
          CONFIG.ROLE,
      });


      startHeartbeat();
    }
  );


  // ----------------------------------------------------------
  // MESSAGE
  // ----------------------------------------------------------

  socket.addEventListener(
    'message',
    (event) => {

      let msg;

      try {

        msg =
          JSON.parse(event.data);

      } catch (err) {

        console.error(
          '[WebSocket] Invalid message from server',
          err
        );

        return;
      }

      handleMessage(msg);
    }
  );


  // ----------------------------------------------------------
  // CLOSE
  // ----------------------------------------------------------

  socket.addEventListener(
    'close',
    (event) => {

      console.warn(
        '[WebSocket] Connection closed',
        {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        }
      );


      // Only react if this is still
      // the active socket.
      if (
        state.socket === socket
      ) {

        state.socket = null;

        setConnectionStatus(false);

        stopHeartbeat();

        scheduleReconnect();
      }
    }
  );


  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

  socket.addEventListener(
    'error',
    (err) => {

      console.error(
        '[WebSocket] Error',
        err
      );

      /*
       * Do NOT call socket.close()
       * here.
       *
       * Browser will normally emit
       * close after the error.
       */
    }
  );
}


// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect() {

  // ----------------------------------------------------------
  // Prevent multiple reconnect timers
  // ----------------------------------------------------------

  if (state.reconnectTimer) {

    console.log(
      '[WebSocket] Reconnect already scheduled'
    );

    return;
  }


  // ----------------------------------------------------------
  // Don't reconnect if socket became active
  // ----------------------------------------------------------

  if (
    state.socket &&
    (
      state.socket.readyState === WebSocket.OPEN ||
      state.socket.readyState === WebSocket.CONNECTING
    )
  ) {

    return;
  }


  const delay =
    Math.min(
      CONFIG.RECONNECT_BASE_MS *
        2 ** state.reconnectAttempt,

      CONFIG.RECONNECT_MAX_MS
    );


  state.reconnectAttempt += 1;


  console.log(
    `[WebSocket] Reconnecting in ${delay}ms`
  );


  state.reconnectTimer =
    setTimeout(
      () => {

        state.reconnectTimer = null;

        connect();

      },
      delay
    );
}


// ============================================================
// HEARTBEAT
// ============================================================

let heartbeatHandle = null;


function startHeartbeat() {

  stopHeartbeat();


  heartbeatHandle =
    setInterval(
      () => {

        send({
          type: 'heartbeat',

          device_id:
            CONFIG.DEVICE_ID,

          status:
            'online',

          last_sync:
            state.playlist
              ? state.playlist.sync_timestamp
              : null,

          network:
            CONFIG.NETWORK,
        });

      },
      CONFIG.HEARTBEAT_INTERVAL_MS
    );
}


function stopHeartbeat() {

  if (heartbeatHandle) {

    clearInterval(
      heartbeatHandle
    );

    heartbeatHandle = null;
  }
}


// ============================================================
// HANDLE SERVER MESSAGE
// ============================================================

function handleMessage(msg) {

  switch (msg.type) {

    // --------------------------------------------------------
    // ACK
    // --------------------------------------------------------

    case 'ack':

      console.log(
        '[ACK]',
        msg.message
      );

      // The server may give this screen another name if ours is already taken
      if (msg.device_id && msg.device_id !== CONFIG.DEVICE_ID) {
        console.warn('[ACK] Name already used by another screen - now ' + msg.device_id);
        CONFIG.DEVICE_ID = msg.device_id;
        showDeviceLabel();
      }

      break;


    // --------------------------------------------------------
    // SERVER ERROR
    // --------------------------------------------------------

    case 'error':

      console.error(
        '[Server Error]',
        msg.message
      );

      break;


    // --------------------------------------------------------
    // PLAYLIST
    // --------------------------------------------------------

    case 'playlist':

      applyPlaylist(msg);

      // Keep showing a frozen frame if the dashboard has paused playback
      if (playback.paused) {
        freezePlayback();
      }

      break;


    // --------------------------------------------------------
    // PLAYBACK CONTROL (pause / volume / mute from dashboard)
    // --------------------------------------------------------

    case 'playback':

      handlePlaybackMessage(msg);

      break;


    // --------------------------------------------------------
    // TASK
    // --------------------------------------------------------

    case 'task':

      state.tasks.set(
        msg.task_id,
        msg
      );

      resolveAndRender();

      // Switch exactly when it starts / ends (e.g. a "play once"
      // video finishing)
      rerenderAt(msg.schedule.start);
      rerenderAt(msg.schedule.end);

      break;


    // --------------------------------------------------------
    // CLEAR TASK (task deleted from dashboard)
    // --------------------------------------------------------

    case 'clear_task':

      state.tasks.delete(
        msg.task_id
      );

      resolveAndRender();

      break;


    // --------------------------------------------------------
    // RESET SCHEDULE ((re)connected: the server now re-sends
    // every current alert and task)
    // --------------------------------------------------------

    case 'reset_schedule':

      state.tasks.clear();

      state.alerts.clear();

      // Re-check once they've arrived. Not right away: a task
      // still running would flash off and its video restart on
      // every reconnect.
      setTimeout(resolveAndRender, 1000);

      break;


    // --------------------------------------------------------
    // CLEAR PLAYLIST (playlist deleted from dashboard)
    // --------------------------------------------------------

    case 'clear_playlist':

      // Only stop if the deleted playlist is the one being shown
      if (
        state.playlist &&
        state.playlist.playlist_id === msg.playlist_id
      ) {

        if (
          state.playlistTimer
        ) {

          clearTimeout(
            state.playlistTimer
          );
        }

        state.playlistTimer =
          null;

        state.playlist =
          null;

        state.playlistIndex =
          0;

        resolveAndRender();
      }

      break;


    // --------------------------------------------------------
    // ALERT
    // --------------------------------------------------------

    case 'alert':

      state.alerts.set(
        msg.alert_id,
        msg
      );

      resolveAndRender();

      rerenderAt(msg.expires);

      break;


    // --------------------------------------------------------
    // CLEAR ALERT
    // --------------------------------------------------------

    case 'clear_alert':

      state.alerts.delete(
        msg.alert_id
      );

      resolveAndRender();

      break;


    // --------------------------------------------------------
    // UNKNOWN
    // --------------------------------------------------------

    default:

      console.warn(
        '[WebSocket] Unknown message type:',
        msg.type
      );
  }
}


// Wi-Fi mode warms media resources so they are more likely to be ready at playback time.
function preloadPlaylist(items) {
  if (TV_MODE !== 'wifi') return;

  items.forEach((item) => {
    if (!item.url || state.preloadedUrls.has(item.url)) return;

    const mediaType = String(item.media_type || '').toLowerCase();
    const isVideo = mediaType === 'video' || (mediaType === 'image' && isVideoUrl(item.url));

    if (isVideo) {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.src = getMediaUrl(item.url);
      video.muted = true;
      state.preloadedUrls.add(item.url);
    } else if (mediaType === 'image') {
      const img = new Image();
      img.src = getMediaUrl(item.url);
      state.preloadedUrls.add(item.url);
    }
  });
}


// ============================================================
// APPLY PLAYLIST
// ============================================================

function applyPlaylist(msg) {

  console.log(
    `[Playlist] Received "${msg.name}"`
  );


  state.playlist = msg;

  preloadPlaylist(msg.items || []);
  if (els.bufferStatus) els.bufferStatus.textContent = '';


  // ----------------------------------------------------------
  // Clear previous playlist timer
  // ----------------------------------------------------------

  if (state.playlistTimer) {

    clearTimeout(
      state.playlistTimer
    );

    state.playlistTimer = null;
  }


  const items =
    msg.items || [];


  // ----------------------------------------------------------
  // Empty playlist
  // ----------------------------------------------------------

  if (!items.length) {

    console.warn(
      '[Playlist] Received empty playlist'
    );

    els.contentRoot.innerHTML =
      '<p class="placeholder">Playlist is empty</p>';

    return;
  }


  // ----------------------------------------------------------
  // Convert sync timestamp
  // ----------------------------------------------------------

  const syncTime =
    new Date(
      msg.sync_timestamp
    ).getTime();


  const now =
    Date.now();


  // ----------------------------------------------------------
  // Invalid timestamp
  // ----------------------------------------------------------

  if (
    Number.isNaN(syncTime)
  ) {

    console.error(
      '[Playlist] Invalid sync_timestamp:',
      msg.sync_timestamp
    );

    return;
  }


  // ----------------------------------------------------------
  // Playlist hasn't started
  // ----------------------------------------------------------

  if (now < syncTime) {

    const delay =
      syncTime - now;

    if (TV_MODE === 'wifi' && els.bufferStatus) {
      els.bufferStatus.textContent = `buffering, starts in ${Math.ceil(delay / 1000)}s`;
    }

    console.log(
      `[SYNC] "${msg.name}" starts in ${delay}ms`
    );


    state.playlistTimer =
      setTimeout(
        () => {

          state.playlistTimer =
            null;

          if (els.bufferStatus) els.bufferStatus.textContent = '';
          startPlaylistFromGlobalTime();

        },
        delay
      );


    return;
  }


  // ----------------------------------------------------------
  // Playlist already started
  // ----------------------------------------------------------

  startPlaylistFromGlobalTime();
}


// ============================================================
// START PLAYLIST FROM GLOBAL TIMELINE
// ============================================================

function startPlaylistFromGlobalTime() {

  const items =
    state.playlist?.items || [];


  if (!items.length) {
    return;
  }


  const syncTime =
    new Date(
      state.playlist.sync_timestamp
    ).getTime();


  const now =
    Date.now();


  if (
    Number.isNaN(syncTime)
  ) {

    console.error(
      '[SYNC] Invalid sync timestamp'
    );

    return;
  }


  // ----------------------------------------------------------
  // Time elapsed since global start
  // ----------------------------------------------------------

  let elapsed =
    now - syncTime;


  // ----------------------------------------------------------
  // Calculate total playlist duration
  // ----------------------------------------------------------

  const totalDuration =
    items.reduce(
      (sum, item) => {

        const duration =
          Number(
            item.duration || 5
          ) * 1000;

        return sum + duration;

      },
      0
    );


  if (
    totalDuration <= 0
  ) {

    console.error(
      '[SYNC] Invalid playlist duration'
    );

    return;
  }


  // ----------------------------------------------------------
  // Loop playlist
  // ----------------------------------------------------------

  elapsed =
    elapsed % totalDuration;


  // ----------------------------------------------------------
  // Find current item
  // ----------------------------------------------------------

  let index = 0;

  let offset = elapsed;


  for (
    let i = 0;
    i < items.length;
    i++
  ) {

    const duration =
      Number(
        items[i].duration || 5
      ) * 1000;


    if (
      offset < duration
    ) {

      index = i;

      break;
    }


    offset -= duration;
  }


  state.playlistIndex =
    index;


  console.log(
    `[SYNC] Playlist: ${state.playlist.name}`
  );

  console.log(
    `[SYNC] Global elapsed: ${elapsed}ms`
  );

  console.log(
    `[SYNC] Starting item: ${index}`
  );

  console.log(
    `[SYNC] Offset: ${offset}ms`
  );


  playPlaylistItem(
    index,
    offset
  );
}


// ============================================================
// PLAY PLAYLIST ITEM
// ============================================================

function playPlaylistItem(
  index,
  offset = 0,
  continuing = false
) {

  const items =
    state.playlist?.items || [];


  if (!items.length) {
    return;
  }


  // A task or alert is on screen: leave it there. The playlist
  // rejoins the shared timeline once it ends.
  if (
    resolveActiveContent().type !== 'playlist'
  ) {

    resolveAndRender();

    return;
  }


  // ----------------------------------------------------------
  // Validate index
  // ----------------------------------------------------------

  if (
    index < 0 ||
    index >= items.length
  ) {

    index = 0;

    offset = 0;
  }


  state.playlistIndex =
    index;


  const item =
    items[index];


  // ----------------------------------------------------------
  // Render current item
  // ----------------------------------------------------------

  // Moving on to the same YouTube video that is already playing
  // (e.g. a one-item playlist): keep the player running instead of
  // reloading it, and just line its timeline up with this item's start.
  if (
    continuing &&
    isSameYouTubeShowing(item)
  ) {

    restartYouTubeTimeline(offset);

  } else {

    renderContentItem(
      item,
      offset
    );
  }


  // ----------------------------------------------------------
  // Duration
  // ----------------------------------------------------------

  const duration =
    Number(
      item.duration || 5
    ) * 1000;


  // ----------------------------------------------------------
  // Remaining duration
  // ----------------------------------------------------------

  const remaining =
    Math.max(
      100,
      duration - offset
    );


  console.log(
    `[PLAY] item=${index} ` +
    `offset=${offset}ms ` +
    `duration=${duration}ms ` +
    `remaining=${remaining}ms`
  );


  // ----------------------------------------------------------
  // Clear old timer
  // ----------------------------------------------------------

  if (
    state.playlistTimer
  ) {

    clearTimeout(
      state.playlistTimer
    );

    state.playlistTimer = null;
  }


  // ----------------------------------------------------------
  // Schedule next item
  // ----------------------------------------------------------

  state.playlistTimer =
    setTimeout(
      () => {

        state.playlistTimer =
          null;


        const nextIndex =
          (
            state.playlistIndex + 1
          ) % items.length;


        playPlaylistItem(
          nextIndex,
          0,
          true
        );

      },
      remaining
    );
}


// ============================================================
// VIDEO URL DETECTION
// ============================================================

function isVideoUrl(url) {

  if (!url) {
    return false;
  }


  return /\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i.test(
    url
  );
}


// ============================================================
// MEDIA URL
// ============================================================

function getMediaUrl(url) {

  if (!url) {
    return '';
  }


  // Uploaded files saved with another host (e.g. "http://localhost:3000/uploads/x.mp4"
  // when uploaded from the laptop) -> reduce to "/uploads/x.mp4" so they load
  // from the backend this TV is connected to.
  url = url.replace(/^https?:\/\/[^/]+(\/uploads\/)/i, '$1');


  // ----------------------------------------------------------
  // Absolute URL
  // ----------------------------------------------------------

  if (
    /^https?:\/\//i.test(url)
  ) {

    return url;
  }


  // ----------------------------------------------------------
  // Uploaded media
  // ----------------------------------------------------------

  if (
    url.startsWith('/uploads/') ||
    url.startsWith('/api/instagram/media/')
  ) {

    try {

      const backendHttpUrl =
        CONFIG.WS_URL
          .replace(
            /^ws:/i,
            'http:'
          )
          .replace(
            /^wss:/i,
            'https:'
          );


      return new URL(
        url,
        backendHttpUrl
      ).toString();

    } catch (err) {

      console.warn(
        '[MEDIA] Could not build backend media URL:',
        err
      );
    }
  }


  return url;
}


// ============================================================
// YOUTUBE
// ============================================================
// Accepts youtube.com/watch?v=, youtu.be/, /shorts/, /embed/ and /live/ links

function getYouTubeId(url) {
  const match = String(url || '').match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i
  );
  return match ? match[1] : null;
}

// Played through YouTube's IFrame Player API rather than a plain embed: it
// reports why a video can't play (instead of YouTube's "Watch on YouTube"
// screen, which takes the TV away from ScreenSync), and lets every screen be
// kept on the same second of the video.

let youTubeApiPromise = null;

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);

  if (!youTubeApiPromise) {
    youTubeApiPromise = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => {
        youTubeApiPromise = null;
        reject(new Error('Unable to reach YouTube'));
      };
      document.head.appendChild(script);
    });
  }

  return youTubeApiPromise;
}

const YOUTUBE_ERRORS = {
  2: 'The YouTube link is not valid.',
  5: 'This YouTube video cannot be played in this browser.',
  100: 'This YouTube video was removed or is private.',
  101: 'The owner of this YouTube video does not allow it to be played outside YouTube.',
  150: 'The owner of this YouTube video does not allow it to be played outside YouTube.',
  152: 'The owner of this YouTube video does not allow it to be played outside YouTube.',
  153: 'YouTube refused to play this video on this page.',
  network: 'This screen cannot reach YouTube. Check its internet connection.',
};

// The YouTube video on screen (only one at a time). `startedAt` is the clock
// time at which the video was at 0:00 on every screen - the shared timeline.
let currentYouTube = null;

function renderYouTube(item, offsetMs = 0) {
  const id = getYouTubeId(item.url);

  if (!id) {
    els.contentRoot.innerHTML =
      '<p class="placeholder">Invalid YouTube link</p>';
    return;
  }

  // The player goes inside this box, which keeps our markers on it
  const frame = document.createElement('div');
  frame.className = 'youtube-frame';
  frame.dataset.videoId = id;
  const playerHost = document.createElement('div');
  frame.appendChild(playerHost);
  els.contentRoot.appendChild(frame);

  const entry = {
    frame,
    player: null,
    ready: false,
    startedAt: Date.now() - (offsetMs || 0),
    lastCorrection: 0,
  };
  currentYouTube = entry;

  loadYouTubeApi()
    .then((YT) => {
      // Replaced by other content while the API was loading
      if (currentYouTube !== entry || !frame.isConnected) return;

      entry.player = new YT.Player(playerHost, {
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          mute: playback.muted || !soundEnabled ? 1 : 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          rel: 0,
          iv_load_policy: 3,
          playsinline: 1,
          start: Math.floor((offsetMs || 0) / 1000),
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            entry.ready = true;
            applyVolume();
            if (playback.paused) {
              entry.player.pauseVideo();
            } else {
              entry.player.seekTo(youTubeTimelineSeconds(entry), true);
              entry.player.playVideo();
            }
          },
          onStateChange: (event) => {
            // Loop: the playlist item / task can last longer than the video
            if (event.data === YT.PlayerState.ENDED && !playback.paused) {
              entry.player.seekTo(0, true);
              entry.player.playVideo();
            }
          },
          onError: (event) => showYouTubeError(entry, event.data),
        },
      });
    })
    .catch(() => showYouTubeError(entry, 'network'));
}

// Replace the player with a readable message (and no "Watch on YouTube" link)
function showYouTubeError(entry, code) {
  if (currentYouTube !== entry || !entry.frame.isConnected) return;
  console.error('[YOUTUBE] Cannot play video, error', code);

  try {
    if (entry.player) entry.player.destroy();
  } catch (e) { /* already gone */ }
  currentYouTube = null;

  entry.frame.innerHTML = '';
  const message = document.createElement('p');
  message.className = 'placeholder youtube-error';
  message.textContent = YOUTUBE_ERRORS[code] || 'This YouTube video could not be played.';
  const hint = document.createElement('small');
  // On an IP address YouTube blocks videos it would play under the PC's name
  const blockedHere = [101, 150, 152].includes(code) && isIpAddress(window.location.hostname);
  hint.textContent = blockedHere
    ? "This screen was opened by IP address, where YouTube blocks some videos. Open it with the ScreenSync PC's name instead (http://<pc-name>:3000/...)."
    : 'Choose another video in ScreenSync, or upload the video file instead.';
  message.appendChild(document.createElement('br'));
  message.appendChild(hint);
  entry.frame.appendChild(message);
}

// Where the video should be right now on the shared timeline (looping)
function youTubeTimelineSeconds(entry) {
  const duration = entry.player.getDuration();
  const seconds = (Date.now() - entry.startedAt) / 1000;
  return duration > 0 ? seconds % duration : seconds;
}

// The same YouTube video carries on as the next playlist item (e.g. a
// one-item playlist): keep the player, just restart its timeline at the
// item's start so it stays in step with the playlist
function restartYouTubeTimeline(offsetMs) {
  const entry = currentYouTube;
  if (!entry) return;
  entry.startedAt = Date.now() - (offsetMs || 0);
  if (entry.ready && !playback.paused) {
    entry.player.seekTo(youTubeTimelineSeconds(entry), true);
  }
}

// Every 2 s, put the YouTube video back on the shared timeline if it has
// drifted (buffering on Wi-Fi, a slow start) or stopped by itself
const YOUTUBE_MAX_DRIFT_S = 1.5;
const YOUTUBE_CORRECTION_GAP_MS = 6000; // let a seek finish buffering first

setInterval(() => {
  const entry = currentYouTube;
  if (!entry || !entry.ready || playback.paused || !entry.frame.isConnected) return;

  const player = entry.player;
  const state = player.getPlayerState();

  if (state === YT.PlayerState.BUFFERING) return;
  if (state !== YT.PlayerState.PLAYING) {
    player.playVideo();
    return;
  }

  const now = Date.now();
  if (now - entry.lastCorrection < YOUTUBE_CORRECTION_GAP_MS) return;

  const expected = youTubeTimelineSeconds(entry);
  const duration = player.getDuration();
  let drift = player.getCurrentTime() - expected;
  // Near the loop point, 0.5 s and duration - 0.5 s are only 1 s apart
  if (duration > 0) {
    if (drift > duration / 2) drift -= duration;
    if (drift < -duration / 2) drift += duration;
  }

  if (Math.abs(drift) > YOUTUBE_MAX_DRIFT_S) {
    console.log(`[YOUTUBE] Drifted ${drift.toFixed(1)}s, re-syncing`);
    entry.lastCorrection = now;
    player.seekTo(expected, true);
  }
}, 2000);

function isSameYouTubeShowing(item) {
  if (String(item.media_type || '').toLowerCase() !== 'youtube') return false;
  const frame = els.contentRoot.querySelector('.youtube-frame');
  return Boolean(frame && frame.dataset.videoId === getYouTubeId(item.url));
}

// ============================================================
// RENDER CONTENT ITEM
// ============================================================

function renderContentItem(
  item,
  offset = 0
) {

  els.contentRoot.innerHTML = '';


  if (!item) {

    console.warn(
      '[MEDIA] Empty playlist item'
    );

    return;
  }


  let mediaType =
    String(
      item.media_type || ''
    ).toLowerCase();


  const mediaUrl =
    getMediaUrl(item.url);


  // ----------------------------------------------------------
  // AUTO-DETECT VIDEO
  // ----------------------------------------------------------

  if (
    mediaType === 'image' &&
    isVideoUrl(mediaUrl)
  ) {

    console.warn(
      '[MEDIA] media_type=image but URL is a video.'
    );

    console.warn(
      '[MEDIA] Treating item as video:',
      mediaUrl
    );

    mediaType = 'video';
  }


  // ==========================================================
  // IMAGE
  // ==========================================================

  if (
    mediaType === 'image'
  ) {

    const img =
      document.createElement('img');


    img.src =
      mediaUrl;


    img.alt =
      item.content || '';


    img.addEventListener(
      'load',
      () => {

        console.log(
          '[IMAGE] Loaded:',
          mediaUrl
        );

      }
    );


    img.addEventListener(
      'error',
      (err) => {

        console.error(
          '[IMAGE] Failed to load:',
          mediaUrl,
          err
        );

      }
    );


    els.contentRoot.appendChild(
      img
    );


    return;
  }


  // ==========================================================
  // VIDEO
  // ==========================================================

  if (
    mediaType === 'video'
  ) {

    console.log(
      `[VIDEO] Loading: ${mediaUrl} | offset=${offset}ms`
    );


    const video =
      document.createElement('video');


    video.src =
      mediaUrl;


    // --------------------------------------------------------
    // Autoplay settings
    // --------------------------------------------------------

    video.autoplay =
      true;

    // Muted until sound is allowed (launch-tv.bat, or a click on the screen)
    video.muted =
      !soundEnabled || playback.muted;

    video.defaultMuted =
      video.muted;

    video.volume =
      playback.volume / 100;

    video.playsInline =
      true;

    video.preload =
      'auto';

    video.loop =
      false;

    video.controls =
      false;


    // --------------------------------------------------------
    // Styling
    // --------------------------------------------------------

    video.style.width =
      '100%';

    video.style.height =
      '100%';

    video.style.objectFit =
      'contain';


    // --------------------------------------------------------
    // Metadata loaded
    // --------------------------------------------------------

    video.addEventListener(
      'loadedmetadata',
      () => {

        console.log(
          `[VIDEO] Metadata loaded | duration=${video.duration}s`
        );


        // ----------------------------------------------------
        // Synchronize position
        // ----------------------------------------------------

        if (
          offset > 0 &&
          Number.isFinite(
            video.duration
          )
        ) {

          const requestedTime =
            offset / 1000;


          const safeTime =
            Math.min(
              Math.max(
                0,
                requestedTime
              ),

              Math.max(
                0,
                video.duration - 0.1
              )
            );


          try {

            video.currentTime =
              safeTime;


            console.log(
              `[VIDEO] Seeked to ${safeTime.toFixed(2)}s`
            );

          } catch (err) {

            console.warn(
              '[VIDEO] Could not set currentTime:',
              err
            );
          }
        }


        // ----------------------------------------------------
        // Start video (unless the dashboard has paused playback)
        // ----------------------------------------------------

        if (playback.paused) return;

        (video.muted ? video.play() : video.play().catch((err) => {
          // A pause from the dashboard also rejects play() - stay paused then
          if (playback.paused) throw err;
          // Browser refused sound - play muted instead
          video.muted = true;
          return video.play();
        }))
          .then(
            () => {

              console.log(
                '[VIDEO] Playing successfully'
              );

            }
          )
          .catch(
            (err) => {

              console.error(
                '[VIDEO] Autoplay/play failed:',
                err
              );

            }
          );
      }
    );


    // --------------------------------------------------------
    // Can play
    // --------------------------------------------------------

    video.addEventListener(
      'canplay',
      () => {

        console.log(
          '[VIDEO] Can play:',
          mediaUrl
        );

      }
    );


    // --------------------------------------------------------
    // Playing
    // --------------------------------------------------------

    video.addEventListener(
      'playing',
      () => {

        console.log(
          '[VIDEO] Playing:',
          mediaUrl
        );

      }
    );


    // --------------------------------------------------------
    // Ended
    // --------------------------------------------------------

    video.addEventListener(
      'ended',
      () => {

        console.log(
          '[VIDEO] Video ended:',
          mediaUrl
        );

      }
    );


    // --------------------------------------------------------
    // Error
    // --------------------------------------------------------

    video.addEventListener(
      'error',
      () => {

        const error =
          video.error;


        console.error(
          '[VIDEO] Failed to load/play video:',
          mediaUrl,
          error
            ? {
                code: error.code,
                message: error.message,
              }
            : 'Unknown video error'
        );


        els.contentRoot.innerHTML =
          '<p class="placeholder">Unable to play video</p>';
      }
    );


    els.contentRoot.appendChild(
      video
    );


    return;
  }


  // ==========================================================
  // YOUTUBE
  // ==========================================================

  if (
    mediaType === 'youtube'
  ) {

    renderYouTube(
      item,
      offset
    );

    return;
  }


  // ==========================================================
  // TEXT
  // ==========================================================

  if (
    mediaType === 'text'
  ) {

    const div =
      document.createElement('div');


    div.className =
      'text-slide';


    div.textContent =
      item.content || '';


    els.contentRoot.appendChild(
      div
    );


    return;
  }


  // ==========================================================
  // UNKNOWN MEDIA TYPE
  // ==========================================================

  console.warn(
    '[Playlist] Unknown media type:',
    item.media_type
  );


  els.contentRoot.innerHTML =
    '<p class="placeholder">Unsupported content type</p>';
}


// ============================================================
// TASK BANNER
// ============================================================

function renderTaskBanner(task) {

  // Already showing this task: leave it alone (this runs every 5 s,
  // and re-rendering would restart the task's video each time)
  const current =
    els.contentRoot.querySelector('.task-banner');

  if (
    current &&
    current.dataset.taskId === task.task_id
  ) {
    return;
  }


  els.contentRoot.innerHTML = '';


  if (
    task.media &&
    task.media.url
  ) {
    renderTaskMedia(task);
  }


  const banner =
    document.createElement('div');


  banner.className =
    'task-banner';

  banner.dataset.taskId =
    task.task_id;


  // textContent, not innerHTML: task text is shown as typed,
  // never run as HTML
  const title =
    document.createElement('strong');

  title.textContent =
    task.title;

  banner.appendChild(title);


  if (task.content) {

    banner.appendChild(
      document.createElement('br')
    );

    banner.appendChild(
      document.createTextNode(task.content)
    );
  }


  els.contentRoot.appendChild(
    banner
  );
}


// Full-screen image / video / YouTube for a task. Every screen starts at
// the same spot: the time since the task's start, looping over the
// video's length.
function renderTaskMedia(task) {

  const {
    media_type: type,
    url,
    duration
  } = task.media;


  const sinceStartMs =
    Math.max(
      0,
      Date.now() -
        new Date(task.schedule.start).getTime()
    );


  if (type === 'image') {

    const img =
      document.createElement('img');

    img.src =
      getMediaUrl(url);

    els.contentRoot.appendChild(img);

    return;
  }


  if (type === 'video') {

    const video =
      document.createElement('video');

    video.src =
      getMediaUrl(url);

    video.loop = true; // repeat until the task ends
    video.muted = !soundEnabled || playback.muted;
    video.volume = playback.volume / 100;
    video.playsInline = true;


    video.addEventListener(
      'loadedmetadata',
      () => {

        if (
          isFinite(video.duration) &&
          video.duration > 0
        ) {
          video.currentTime =
            (sinceStartMs / 1000) % video.duration;
        }


        if (playback.paused) return;


        // Play with sound if allowed, otherwise fall back to muted
        video.play().catch(() => {

          if (
            !video.muted &&
            !playback.paused
          ) {
            video.muted = true;
            video.play().catch(() => {});
          }
        });
      }
    );


    els.contentRoot.appendChild(video);

    return;
  }


  if (type === 'youtube') {

    const offsetMs =
      duration > 0
        ? sinceStartMs % (duration * 1000)
        : 0;

    renderYouTube(
      { url },
      offsetMs
    );
  }
}


// ============================================================
// ALERT
// ============================================================

// Shows every active alert at once (list is already sorted:
// highest priority first, newest first within the same priority)
const ALERT_LABELS = {
  1: 'LOW',
  2: 'MEDIUM',
  3: 'HIGH',
  4: 'EMERGENCY',
};

function showAlert(alerts) {

  els.alertMessage.innerHTML = '';

  alerts.forEach((alert) => {

    const line =
      document.createElement('p');

    line.className =
      'alert-line';

    const tag =
      document.createElement('span');

    tag.className =
      'alert-tag';

    tag.textContent =
      ALERT_LABELS[alert.priority] || 'ALERT';

    line.append(
      tag,
      alert.message
    );

    els.alertMessage.appendChild(
      line
    );
  });


  // Screen colour follows the highest priority (list is sorted, so it's the first)
  els.alertOverlay.className =
    `alert-overlay priority-${alerts[0].priority}`;
}


function hideAlert() {

  els.alertOverlay.classList.add(
    'hidden'
  );
}


// ============================================================
// RESOLVE ACTIVE CONTENT
// ============================================================

function resolveActiveContent() {

  const now =
    new Date();


  // ==========================================================
  // ALERTS
  // ==========================================================

  const activeAlerts =
    Array.from(
      state.alerts.values()
    ).filter(
      (a) =>
        new Date(a.expires) > now
    );


  if (
    activeAlerts.length > 0
  ) {

    // Map keeps arrival order -> reverse so newest comes first,
    // then a stable sort puts higher priority on top
    const sorted =
      activeAlerts
        .reverse()
        .sort(
          (a, b) =>
            b.priority - a.priority
        );


    return {
      type: 'alert',
      content: sorted,
    };
  }


  // ==========================================================
  // TASKS
  // ==========================================================

  const activeTasks =
    Array.from(
      state.tasks.values()
    ).filter(
      (t) => {

        if (
          !t.schedule ||
          !t.schedule.start ||
          !t.schedule.end
        ) {
          return false;
        }


        const start =
          new Date(
            t.schedule.start
          );


        const end =
          new Date(
            t.schedule.end
          );


        return (
          start <= now &&
          end >= now
        );
      }
    );


  if (
    activeTasks.length > 0
  ) {

    const top =
      activeTasks.sort(
        (a, b) =>
          b.priority - a.priority
      )[0];


    return {
      type: 'task',
      content: top,
    };
  }


  // ==========================================================
  // PLAYLIST
  // ==========================================================

  if (
    state.playlist
  ) {

    return {
      type: 'playlist',
      content: state.playlist,
    };
  }


  // ==========================================================
  // NOTHING
  // ==========================================================

  return {
    type: null,
    content: null,
  };
}


window.resolveActiveContent =
  resolveActiveContent;


// ============================================================
// RESOLVE AND RENDER
// ============================================================

function resolveAndRender() {

  pruneExpired();


  const {
    type,
    content
  } =
    resolveActiveContent();


  // ==========================================================
  // ALERT
  // ==========================================================

  if (
    type === 'alert'
  ) {

    // Stop the playlist underneath so its sound doesn't play over the
    // alert; it rejoins the shared timeline once the alert ends
    if (
      !playback.paused
    ) {

      if (
        state.playlistTimer
      ) {

        clearTimeout(
          state.playlistTimer
        );

        state.playlistTimer =
          null;
      }


      els.contentRoot.innerHTML =
        '';
    }


    showAlert(
      content
    );


    return;
  }


  hideAlert();


  // ==========================================================
  // TASK
  // ==========================================================

  if (
    type === 'task'
  ) {

    if (
      state.playlistTimer
    ) {

      clearTimeout(
        state.playlistTimer
      );

      state.playlistTimer =
        null;
    }


    renderTaskBanner(
      content
    );


    return;
  }


  // ==========================================================
  // PLAYLIST
  // ==========================================================

  if (
    type === 'playlist'
  ) {

    /*
     * Do NOT restart the playlist every 5 seconds.
     *
     * When no timer exists, calculate the current
     * position from the global sync timestamp.
     */

    if (
      !state.playlistTimer &&
      !playback.paused
    ) {

      startPlaylistFromGlobalTime();
    }


    // Paused while a task / alert was showing and it has now ended:
    // put the playlist back (frozen) instead of leaving the screen
    // blank or showing the old task
    if (
      playback.paused &&
      (
        !els.contentRoot.children.length ||
        els.contentRoot.querySelector('.task-banner')
      )
    ) {

      startPlaylistFromGlobalTime();

      freezePlayback();
    }


    return;
  }


  // ==========================================================
  // NO CONTENT
  // ==========================================================

  els.contentRoot.innerHTML =
    '<p class="placeholder">Waiting for content from ScreenSync...</p>';
}


// ============================================================
// REMOVE EXPIRED TASKS / ALERTS
// ============================================================

function pruneExpired() {

  const now =
    new Date();


  // ==========================================================
  // ALERTS
  // ==========================================================

  for (
    const [id, alert]
    of state.alerts.entries()
  ) {

    if (
      new Date(alert.expires) <= now
    ) {

      state.alerts.delete(id);
    }
  }


  // ==========================================================
  // TASKS
  // ==========================================================

  for (
    const [id, task]
    of state.tasks.entries()
  ) {

    if (
      task.schedule &&
      task.schedule.end &&
      new Date(
        task.schedule.end
      ) <= now
    ) {

      state.tasks.delete(id);
    }
  }
}


// ============================================================
// PERIODIC PRIORITY CHECK
// ============================================================

state.priorityCheckTimer =
  setInterval(
    resolveAndRender,
    5000
  );


// Re-check at an exact moment (a task starting or ending, an alert
// expiring), instead of waiting up to 5 s for the periodic check
function rerenderAt(time) {
  const delay = new Date(time).getTime() - Date.now();
  // setTimeout can't wait longer than ~24 days; the periodic check covers that
  if (delay > 0 && delay < 2147483647) setTimeout(resolveAndRender, delay + 50);
}


// ============================================================
// REMOTE PLAYBACK CONTROL (from the dashboard)
// ============================================================
// Resume / next / previous / restart arrive as a re-sent playlist with a shifted
// sync_timestamp (so every screen lands on the same spot). Here we only freeze
// the screen on pause and apply volume / mute.

const playback = {
  paused: false,
  volume: 100, // 0-100
  muted: false,
};

function eachVideo(fn) {
  document.querySelectorAll('.content-root video').forEach(fn);
}

// Control the YouTube player on screen (pauseVideo, playVideo, setVolume, mute, unMute)
function youtubeCommand(func, args = []) {
  const entry = currentYouTube;
  if (!entry || !entry.ready || !entry.frame.isConnected) return;
  try {
    entry.player[func](...args);
  } catch (e) { /* player already gone */ }
}

function applyVolume() {
  const silent = playback.muted || !soundEnabled;
  eachVideo((video) => {
    video.volume = playback.volume / 100;
    video.muted = silent;
  });
  youtubeCommand('setVolume', [playback.volume]);
  youtubeCommand(silent ? 'mute' : 'unMute');
}

function freezePlayback() {
  playback.paused = true;
  if (state.playlistTimer) {
    clearTimeout(state.playlistTimer);
    state.playlistTimer = null;
  }
  eachVideo((video) => video.pause());
  youtubeCommand('pauseVideo');
}

// A YouTube player that started muted can only get sound by reloading it,
// so re-render the current item at the current position (now with sound)
function reloadYouTubeWithSound() {
  const silent = playback.muted || !soundEnabled;
  if (silent || playback.paused || !document.querySelector('.youtube-frame')) return;
  // A task's YouTube video is showing: re-render the task, not the playlist
  if (els.contentRoot.querySelector('.task-banner')) {
    els.contentRoot.innerHTML = '';
    resolveAndRender();
    return;
  }
  if (!state.playlist) return;
  startPlaylistFromGlobalTime();
}

function handlePlaybackMessage(msg) {
  const wasSilent = playback.muted || !soundEnabled;
  playback.volume = Number.isFinite(msg.volume) ? msg.volume : playback.volume;
  playback.muted = Boolean(msg.muted);
  applyVolume();
  if (wasSilent) reloadYouTubeWithSound();

  if (msg.paused) {
    if (!playback.paused) freezePlayback();
  } else {
    // Unpausing: the backend follows up with the playlist at the right position
    const wasPaused = playback.paused;
    playback.paused = false;
    // A task stays on screen through that, so restart its own media here
    if (wasPaused && els.contentRoot.querySelector('.task-banner')) {
      eachVideo((video) => video.play().catch(() => {}));
      youtubeCommand('playVideo');
    }
  }
}

// ============================================================
// SOUND + FULL SCREEN
// ============================================================
// Content always starts by itself (muted video may autoplay). Sound is another
// matter: browsers only allow it after a click on the page - unless the browser
// was opened with launch-tv.bat, which allows autoplay with sound (and runs full
// screen). Without that, a small "Sound off" note shows until someone clicks
// anywhere once.

// True when this browser lets videos play with sound without a click
function soundAllowedWithoutClick() {
  try {
    if (navigator.getAutoplayPolicy) {
      return navigator.getAutoplayPolicy('mediaelement') === 'allowed';
    }
  } catch (e) { /* not supported - try the next check */ }
  try {
    // Audio starts out suspended in browsers that need a click first
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const allowed = ctx.state === 'running';
    ctx.close();
    return allowed;
  } catch (e) {
    return false;
  }
}

let soundEnabled = soundAllowedWithoutClick();

const soundHint = document.getElementById('sound-hint');

// Launched as a kiosk (launch-tv.bat): already full screen, no status strip
const isKiosk = new URLSearchParams(window.location.search).has('kiosk');
if (isKiosk) document.documentElement.classList.add('kiosk');

function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

// True when the page already fills the whole screen: real full screen, F11,
// or a kiosk window (launch-tv.bat / a TV's URL launcher). ?kiosk=1 alone
// doesn't count - it is also typed into ordinary browser windows.
function coversScreen() {
  return isFullscreen() ||
    (window.innerWidth >= window.screen.width && window.innerHeight >= window.screen.height);
}

// Browsers only allow this from a click / key press
function enterFullscreen() {
  if (isFullscreen()) return;
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  try {
    // Returns a promise in modern browsers; ignore refusals (e.g. iPhone)
    if (request) Promise.resolve(request.call(root)).catch(() => {});
  } catch (e) { /* full screen not supported */ }
}

// The corner note says what one click would still fix (sound and/or full screen)
function updateScreenHint() {
  const needsFullscreen = !coversScreen();
  if (soundEnabled && !needsFullscreen) {
    soundHint.classList.add('hidden');
    return;
  }
  soundHint.textContent = soundEnabled
    ? 'Click anywhere for full screen'
    : '\u{1F507} Click anywhere for full screen and sound';
  soundHint.classList.remove('hidden');
}

function enableSound() {
  if (soundEnabled) return;
  soundEnabled = true;

  // Unmute what is already playing (respecting the dashboard's mute/volume)
  applyVolume();
  if (!playback.paused) {
    eachVideo((video) => video.play().catch(() => {}));
  }
  reloadYouTubeWithSound();
}

// One click or key press anywhere: full screen + sound. (Esc leaves full
// screen; the note then comes back so the next click can re-enter it.)
function onScreenInteraction() {
  enterFullscreen();
  enableSound();
  updateScreenHint();
}

document.addEventListener('click', onScreenInteraction);
document.addEventListener('keydown', onScreenInteraction);
document.addEventListener('fullscreenchange', updateScreenHint);
document.addEventListener('webkitfullscreenchange', updateScreenHint);
window.addEventListener('resize', updateScreenHint); // e.g. F11 pressed
updateScreenHint();

// Hide the mouse pointer when it hasn't moved for 3 s (it's a TV)
let cursorTimer = null;
function showCursorBriefly() {
  document.documentElement.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.documentElement.classList.add('hide-cursor'), 3000);
}
document.addEventListener('mousemove', showCursorBriefly);
showCursorBriefly();


// ============================================================
// START
// ============================================================

// ============================================================
// IP ADDRESS -> PC NAME
// ============================================================
// YouTube refuses some videos (error 150) on pages opened by IP address,
// e.g. http://172.22.20.118:3000, yet plays them when the same page is
// opened by the PC's name (http://<pc-name>:3000). A page opened by IP
// therefore checks whether this screen can reach the PC by name and, if
// so, reloads itself under that name (same page, same ?id=...). If the
// name can't be reached, the page just stays on the IP address.

function isIpAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

async function switchToPcName() {
  const { protocol, hostname, port, pathname, search, hash } = window.location;
  if (!isIpAddress(hostname)) return false;

  try {
    // The ScreenSync server reports its own name
    const health = await fetch('/health', { cache: 'no-store' }).then((res) => res.json());
    const name = health && health.data && health.data.hostname;
    if (!name || isIpAddress(name)) return false;

    const base = `${protocol}//${name}${port ? `:${port}` : ''}`;

    // Can this screen reach the PC by name? Any reply within 3 s will do
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(`${base}/health`, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);

    console.log(`[SCREEN] Switching to ${base} (YouTube allows more videos there)`);
    window.location.replace(base + pathname + search + hash);
    return true;
  } catch (e) {
    // Name not reachable from this screen (or not served by ScreenSync): stay on the IP
    return false;
  }
}

switchToPcName().then((switching) => {
  if (!switching) connect();
});

