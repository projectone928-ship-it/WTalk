const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const STORE_FILE = process.env.WTALK_STORE || path.join(__dirname, 'data', 'offline-notifications.json');
const channels = new Map();

function ensureStore() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{}');
}
function loadQueues() {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8') || '{}'); } catch { return {}; }
}
let queuedNotifications = loadQueues();
function saveQueues() {
  ensureStore();
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(queuedNotifications, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}
function clean(value) { return String(value || '').trim(); }
function channelKey(name) { return clean(name).toLowerCase(); }
function getChannel(name, password = '') {
  const key = channelKey(name);
  if (!key) return null;
  let channel = channels.get(key);
  if (!channel) {
    channel = { name: clean(name), password: clean(password), members: new Map(), notificationSockets: new Map(), floorOwner: null };
    channels.set(key, channel);
  }
  return channel;
}
function emitUserList(channel) {
  const users = [...channel.members.values()].map(member => ({
    username: member.username,
    isOnline: true,
    isSpeaking: channel.floorOwner === member.socketId,
  }));
  for (const member of channel.members.values()) member.socket.emit('update_user_list', users);
  for (const socket of channel.notificationSockets.values()) socket.emit('update_user_list', users);
}
function leaveMember(socket) {
  const state = socket.data.wtalk;
  if (!state || !state.channel) return;
  const channel = channels.get(channelKey(state.channel));
  if (!channel) return;
  if (channel.members.get(state.username)?.socketId === socket.id) channel.members.delete(state.username);
  if (channel.floorOwner === socket.id) {
    channel.floorOwner = null;
    io.to(channelKey(channel.name)).emit('floor_status', { isBusy: false, speaker: '' });
  }
  if (channel.notificationSockets.get(state.username) === socket) channel.notificationSockets.delete(state.username);
  emitUserList(channel);
  socket.data.wtalk = null;
  if (!channel.members.size && !channel.notificationSockets.size) channels.delete(channelKey(channel.name));
}
function queueFor(username, payload) {
  const key = clean(username);
  if (!key) return;
  queuedNotifications[key] = [...(queuedNotifications[key] || []), payload].slice(-50);
  saveQueues();
}
function deliverQueued(channel, username, socket) {
  const key = clean(username);
  const pending = queuedNotifications[key] || [];
  for (const item of pending) socket.emit('offline_notification', item);
  if (pending.length) {
    delete queuedNotifications[key];
    saveQueues();
  }
}
function findNotificationSocket(channel, username) {
  return channel.notificationSockets.get(clean(username));
}
function sendOfflineNotification(data, senderSocket) {
  const channelName = clean(data.channelName);
  const target = clean(data.targetUsername);
  const sender = clean(data.senderUsername);
  if (!channelName || !target || !sender || target === sender) return { ok: false, error: 'invalid_target' };
  const channel = getChannel(channelName, data.password);
  const payload = {
    title: clean(data.title) || 'Come back to WTalk',
    message: clean(data.message) || `${sender} is waiting for you in WTalk.`,
    senderUsername: sender,
    targetUsername: target,
    channelName,
    createdAt: Date.now(),
  };
  const recipient = findNotificationSocket(channel, target);
  if (recipient && recipient.connected) {
    recipient.emit('offline_notification', payload);
    return { ok: true, delivered: true, queued: false };
  }
  queueFor(target, payload);
  return { ok: true, delivered: false, queued: true };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'WTalk Socket.IO server' }));
});
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

io.on('connection', socket => {
  socket.on('join_channel', (data = {}, ack) => {
    const channelName = clean(data.channelName);
    const username = clean(data.username);
    if (!channelName || !username) return typeof ack === 'function' && ack({ success: false, message: 'channelName and username are required' });
    const channel = getChannel(channelName, data.password);
    if (channel.password && clean(data.password) !== channel.password) return typeof ack === 'function' && ack({ success: false, message: 'Invalid channel password' });
    leaveMember(socket);
    socket.data.wtalk = { channel: channel.name, username, socketId: socket.id, notificationOnly: false };
    channel.members.set(username, { username, socketId: socket.id, socket });
    socket.join(channelKey(channel.name));
    socket.emit('join_result', { success: true, message: `Joined ${channel.name}` });
    emitUserList(channel);
    if (typeof ack === 'function') ack({ success: true });
  });

  socket.on('register_notification', (data = {}, ack) => {
    const channelName = clean(data.channelName);
    const username = clean(data.username);
    if (!channelName || !username) return typeof ack === 'function' && ack({ success: false, message: 'channelName and username are required' });
    const channel = getChannel(channelName, data.password);
    if (channel.password && clean(data.password) !== channel.password) return typeof ack === 'function' && ack({ success: false, message: 'Invalid channel password' });
    leaveMember(socket);
    socket.data.wtalk = { channel: channel.name, username, socketId: socket.id, notificationOnly: true };
    socket.join(channelKey(channel.name));
    channel.notificationSockets.set(username, socket);
    const pendingCount = (queuedNotifications[username] || []).length;
    deliverQueued(channel, username, socket);
    socket.emit('offline_notifications', { count: pendingCount });
    if (typeof ack === 'function') ack({ success: true, notificationOnly: true });
  });

  socket.on('notify_user', (data = {}, ack) => {
    const result = sendOfflineNotification(data, socket);
    socket.emit('notify_user_result', result);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('request_talk', data => {
    const state = socket.data.wtalk;
    const channel = state && channels.get(channelKey(state.channel));
    if (!channel || channel.floorOwner) return socket.emit('talk_denied', { message: 'Line is currently busy!' });
    channel.floorOwner = socket.id;
    io.to(channelKey(channel.name)).emit('floor_status', { isBusy: true, speaker: state.username });
    socket.emit('talk_granted');
  });
  socket.on('stop_talk', () => {
    const state = socket.data.wtalk;
    const channel = state && channels.get(channelKey(state.channel));
    if (channel && channel.floorOwner === socket.id) {
      channel.floorOwner = null;
      io.to(channelKey(channel.name)).emit('floor_status', { isBusy: false, speaker: '' });
    }
  });
  socket.on('send_audio', data => {
    const state = socket.data.wtalk;
    if (!state) return;
    const channel = channels.get(channelKey(state.channel));
    if (!channel) return;
    socket.to(channelKey(channel.name)).emit('receive_audio', { ...data, username: state.username });
  });
  socket.on('leave_channel', () => leaveMember(socket));
  socket.on('disconnect', () => leaveMember(socket));
});

server.listen(PORT, '0.0.0.0', () => console.log(`WTalk server listening on ${PORT}`));
