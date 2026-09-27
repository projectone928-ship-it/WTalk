require('dotenv').config();
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { createStorage } = require('./storage');
const { createPinVoiceRouter } = require('./pinVoiceRoutes');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './storage/pin-voices');
const inactiveDays = Number(process.env.INACTIVE_USER_DAYS || 7);
const maxBytes = Number(process.env.MAX_PIN_AUDIO_BYTES || 5 * 1024 * 1024);

const storage = createStorage({ dataDir, uploadDir, inactiveDays });
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST', 'DELETE'] }
});
const channels = new Map();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '256kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'wtalk-server' }));
app.use('/api/pin-voices', createPinVoiceRouter({ storage, uploadDir, maxBytes, io }));

function channelUsers(channelName) {
  const channel = channels.get(channelName);
  return channel ? [...channel.values()] : [];
}

function emitUsers(channelName) {
  io.to(channelName).emit('update_user_list', channelUsers(channelName));
}

function removeSocket(socket) {
  for (const [channelName, users] of channels) {
    const user = users.get(socket.id);
    if (!user) continue;
    users.delete(socket.id);
    if (!users.size) channels.delete(channelName);
    emitUsers(channelName);
  }
}

io.on('connection', (socket) => {
  socket.on('join_channel', async (data = {}) => {
    const channelName = String(data.channelName || '').trim();
    const username = String(data.username || '').trim();
    if (!channelName || !username) return socket.emit('join_result', { success: false, message: 'Channel and username are required.' });
    socket.data.channelName = channelName;
    socket.data.username = username;
    await storage.touchUser({ channelName, username });
    if (!channels.has(channelName)) channels.set(channelName, new Map());
    const users = channels.get(channelName);
    socket.join(channelName);
    users.set(socket.id, { username, isOnline: true, isSpeaking: false });
    socket.emit('join_result', { success: true, message: 'Joined channel.' });
    emitUsers(channelName);
    socket.emit('pin_voice_list', { items: storage.listPinVoices(channelName).map(storage.publicVoice) });
  });

  socket.on('request_talk', () => {
    const channelName = socket.data.channelName;
    const username = socket.data.username;
    const users = channels.get(channelName);
    if (!users) return;
    const busyUser = [...users.values()].find((user) => user.isSpeaking);
    if (busyUser && busyUser.username !== username) return socket.emit('talk_denied', { message: 'Line is currently busy.' });
    const current = users.get(socket.id);
    if (current) current.isSpeaking = true;
    io.to(channelName).emit('floor_status', { isBusy: true, speaker: username });
    socket.emit('talk_granted');
  });

  socket.on('stop_talk', () => {
    const channelName = socket.data.channelName;
    const users = channels.get(channelName);
    const current = users?.get(socket.id);
    if (current) current.isSpeaking = false;
    if (channelName) io.to(channelName).emit('floor_status', { isBusy: false, speaker: '' });
  });

  socket.on('send_audio', (data = {}) => {
    const channelName = socket.data.channelName;
    if (channelName) socket.to(channelName).emit('receive_audio', { ...data, username: socket.data.username });
  });

  socket.on('notify_user', (data = {}) => {
    const channelName = socket.data.channelName;
    if (!channelName) return;
    const target = String(data.targetUsername || '');
    const users = channels.get(channelName) || new Map();
    for (const [socketId, user] of users) {
      if (user.username === target) io.to(socketId).emit('notify_user', data);
    }
  });

  socket.on('disconnect', () => removeSocket(socket));
});

async function start() {
  await storage.init();
  setInterval(async () => {
    try {
      const removed = await storage.removeInactiveUsers();
      for (const user of removed) {
        io.to(user.channelName).emit('user_removed', { username: user.username, reason: 'inactive_7_days' });
      }
    } catch (error) {
      console.error('[cleanup]', error);
    }
  }, 60 * 60 * 1000).unref();
  httpServer.listen(PORT, HOST, () => console.log(`WTalk server listening on http://${HOST}:${PORT}`));
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
