const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const QUEUE_FILE = path.join(DATA_DIR, "offline-queue.json");
const MAX_QUEUE_PER_USER = 100;
const MAX_MESSAGE_LENGTH = 500;

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadQueue() {
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (_) {
    return {};
  }
}

let offlineQueue = loadQueue();
let saveTimer = null;

function saveQueueSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tempFile = `${QUEUE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(offlineQueue, null, 2));
    fs.renameSync(tempFile, QUEUE_FILE);
  }, 100);
}

function clean(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function queueForUser(username, item) {
  const user = clean(username);
  if (!user) return;
  if (!Array.isArray(offlineQueue[user])) offlineQueue[user] = [];
  offlineQueue[user].push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...item,
  });
  offlineQueue[user] = offlineQueue[user].slice(-MAX_QUEUE_PER_USER);
  saveQueueSoon();
}

function takeQueuedMessages(username) {
  const user = clean(username);
  const messages = Array.isArray(offlineQueue[user]) ? offlineQueue[user] : [];
  delete offlineQueue[user];
  if (messages.length) saveQueueSoon();
  return messages;
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "WTalk server", time: new Date().toISOString() });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, connectedUsers: onlineUsers.size });
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

const onlineUsers = new Map(); // username -> { socketId, channelName, socket }
const socketUsers = new Map(); // socketId -> { username, channelName, notificationOnly }
const notificationSockets = new Map(); // username -> { socket, channelName }
// channelName -> Map<username, { socketId: string|null, notificationOnly: boolean }>
const channels = new Map();

function broadcastUsers(channelName) {
  const members = channels.get(channelName);
  if (!members) return;
  const users = Array.from(members.entries()).map(([username, member]) => ({
    username,
    // Notification-only users remain visible but are deliberately offline.
    isOnline: !member.notificationOnly && Boolean(member.socketId) && io.sockets.sockets.has(member.socketId),
    isSpeaking: false,
  }));
  io.to(channelName).emit("update_user_list", { users });
}

function emitPendingNotifications(socket, username) {
  const pending = takeQueuedMessages(username);
  if (pending.length) {
    socket.emit("offline_notifications", { count: pending.length, notifications: pending });
  }
}

function findUser(username) {
  return onlineUsers.get(clean(username));
}

function findNotificationSocket(username, channelName) {
  const entry = notificationSockets.get(clean(username));
  if (!entry || entry.channelName !== clean(channelName) || !entry.socket.connected) return null;
  return entry.socket;
}

function removeActivePresence(socket, keepOfflineMember = false) {
  const info = socketUsers.get(socket.id);
  if (!info) return null;

  const current = onlineUsers.get(info.username);
  if (current && current.socketId === socket.id) onlineUsers.delete(info.username);

  const members = channels.get(info.channelName);
  if (members && members.get(info.username)?.socketId === socket.id) {
    if (keepOfflineMember) {
      members.set(info.username, { socketId: null, notificationOnly: true });
    } else {
      members.delete(info.username);
    }
  }

  if (members && members.size === 0) channels.delete(info.channelName);
  return info;
}

function registerNotificationPresence(socket, username, channelName) {
  const previous = socketUsers.get(socket.id);
  if (previous && (previous.username !== username || previous.channelName !== channelName)) {
    removeActivePresence(socket, false);
  } else {
    removeActivePresence(socket, true);
  }

  socket.data.username = username;
  socket.data.channelName = channelName;
  socket.data.notificationOnly = true;
  socketUsers.set(socket.id, { username, channelName, notificationOnly: true });
  notificationSockets.set(username, { socket, channelName });

  if (!channels.has(channelName)) channels.set(channelName, new Map());
  channels.get(channelName).set(username, { socketId: null, notificationOnly: true });
  socket.leave(channelName);

  socket.emit("notification_registration_result", {
    success: true,
    message: `Notification mode registered for ${channelName}`,
  });
  // Deliver notifications queued before notification mode started.
  emitPendingNotifications(socket, username);
  broadcastUsers(channelName);
}

io.on("connection", (socket) => {
  socket.on("join_channel", (payload = {}) => {
    const username = clean(payload.username);
    const channelName = clean(payload.channelName);
    const password = clean(payload.password);

    if (!username || !channelName || !password) {
      socket.emit("join_result", { success: false, message: "Username, channel and password are required" });
      return;
    }

    const oldInfo = socketUsers.get(socket.id);
    if (oldInfo && (oldInfo.username !== username || oldInfo.channelName !== channelName || oldInfo.notificationOnly)) {
      const oldChannel = oldInfo.channelName;
      removeActivePresence(socket, false);
      socket.leave(oldChannel);
      broadcastUsers(oldChannel);
    }

    socket.join(channelName);
    socket.data.username = username;
    socket.data.channelName = channelName;
    socket.data.notificationOnly = false;
    socketUsers.set(socket.id, { username, channelName, notificationOnly: false });

    if (!channels.has(channelName)) channels.set(channelName, new Map());
    channels.get(channelName).set(username, { socketId: socket.id, notificationOnly: false });
    onlineUsers.set(username, { socketId: socket.id, channelName, socket });

    socket.emit("join_result", { success: true, message: `Joined ${channelName}` });
    emitPendingNotifications(socket, username);
    broadcastUsers(channelName);
  });

  socket.on("leave_channel", () => {
    const info = removeActivePresence(socket, false);
    if (!info) return;
    socket.data.notificationOnly = false;
    socketUsers.set(socket.id, { ...info, notificationOnly: false });
    socket.leave(info.channelName);
    broadcastUsers(info.channelName);
  });

  socket.on("register_notification", (payload = {}) => {
    const username = clean(payload.username);
    const channelName = clean(payload.channelName);
    const password = clean(payload.password);

    if (!username || !channelName || !password) {
      socket.emit("notification_registration_result", {
        success: false,
        message: "Username, channel and password are required",
      });
      return;
    }

    // Keep the user in the channel list, but mark them offline so other
    // clients can show Come Back and queue an offline notification.
    registerNotificationPresence(socket, username, channelName);
  });

  socket.on("request_talk", (payload = {}) => {
    const channelName = clean(payload.channelName || socket.data.channelName);
    const username = clean(payload.username || socket.data.username);
    if (!channelName || !username || socket.data.notificationOnly) return;
    socket.to(channelName).emit("floor_status", { isBusy: true, speaker: username });
    socket.emit("talk_granted", { success: true });
  });

  socket.on("stop_talk", (payload = {}) => {
    const channelName = clean(payload.channelName || socket.data.channelName);
    if (channelName && !socket.data.notificationOnly) io.to(channelName).emit("floor_status", { isBusy: false, speaker: "" });
  });

  socket.on("send_audio", (payload = {}) => {
    const channelName = clean(payload.channelName || socket.data.channelName);
    if (!channelName || !payload.audioData || socket.data.notificationOnly) return;
    socket.to(channelName).emit("receive_audio", {
      username: clean(payload.username || socket.data.username),
      audioData: String(payload.audioData),
    });
  });

  socket.on("send_nudge", (payload = {}) => {
    const senderUsername = clean(payload.senderUsername || socket.data.username);
    const targetUsername = clean(payload.targetUsername);
    const channelName = clean(payload.channelName || socket.data.channelName);
    if (!targetUsername) return;

    const target = findUser(targetUsername);
    const notificationSocket = findNotificationSocket(targetUsername, channelName);
    const notification = {
      type: "nudge",
      senderUsername,
      targetUsername,
      channelName,
      title: "WTalk nudge",
      message: `${senderUsername} nudged you`,
    };

    if (target && target.socket && target.channelName === channelName) {
      socket.emit("notify_result", {
        success: false,
        delivered: false,
        queued: false,
        reason: "USER_ONLINE",
        message: "This notification is for offline users only",
      });
    } else if (notificationSocket) {
      notificationSocket.emit("offline_notification", notification);
      socket.emit("notify_result", { success: true, delivered: true, queued: false });
    } else {
      queueForUser(targetUsername, notification);
      socket.emit("notify_result", { success: true, delivered: false, queued: true });
    }
  });

  socket.on("notify_user", (payload = {}) => {
    const senderUsername = clean(payload.senderUsername || socket.data.username);
    const targetUsername = clean(payload.targetUsername);
    const channelName = clean(payload.channelName || socket.data.channelName);
    const message = clean(payload.message);
    if (!targetUsername || !message) {
      socket.emit("notify_result", { success: false, message: "Target user and message are required" });
      return;
    }

    const notification = {
      type: "user_notification",
      senderUsername,
      targetUsername,
      channelName,
      title: clean(payload.title, "WTalk notification").slice(0, 80),
      message: message.slice(0, MAX_MESSAGE_LENGTH),
    };
    const target = findUser(targetUsername);
    const notificationSocket = findNotificationSocket(targetUsername, channelName);

    if (target && target.socket && target.channelName === channelName) {
      socket.emit("notify_result", {
        success: false,
        delivered: false,
        queued: false,
        reason: "USER_ONLINE",
        message: "This notification is for offline users only",
      });
    } else if (notificationSocket) {
      notificationSocket.emit("offline_notification", notification);
      socket.emit("notify_result", { success: true, delivered: true, queued: false });
    } else {
      queueForUser(targetUsername, notification);
      socket.emit("notify_result", { success: true, delivered: false, queued: true });
    }
  });

  socket.on("get_pending_notifications", () => {
    emitPendingNotifications(socket, socket.data.username);
  });

  socket.on("disconnect", () => {
    const info = socketUsers.get(socket.id);
    if (!info) return;

    // Retain notification-only presence as an offline member after socket loss.
    removeActivePresence(socket, Boolean(info.notificationOnly));
    const notificationEntry = notificationSockets.get(info.username);
    if (notificationEntry && notificationEntry.socket.id === socket.id) notificationSockets.delete(info.username);
    socketUsers.delete(socket.id);
    broadcastUsers(info.channelName);
  });
});

httpServer.listen(PORT, () => {
  console.log(`WTalk server listening on port ${PORT}`);
});

process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
process.on("SIGINT", () => httpServer.close(() => process.exit(0)));
