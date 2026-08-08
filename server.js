const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());

// Firebase Admin Initializer
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log(">>> Firebase Admin Initialized Successfully!");
} catch (error) {
  console.warn(">>> Firebase Admin Init Warning:", error.message);
}

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e7,
  pingTimeout: 30000,
  pingInterval: 10000
});

// Hardcoded Channel & Password
const ALLOWED_CHANNEL = "Quarkofficial9";
const ALLOWED_PASSWORD = "quarkmemberonly9";

// State Trackers
const activeSpeakers = {};
const channelUsers = {};
const userPresence = {};

app.get('/', (req, res) => {
  res.send("WTALK Walkie-Talkie Audio Server is Running!");
});

function parseData(data) {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch (e) { return null; }
  }
  return data;
}

// 📍 အဓိကပြင်ဆင်ထားသော Function (User အားလုံးကို isOnline status နှင့်တကွ ပို့ပေးသည်)
function emitUsersList(channelName) {
  if (!channelUsers[channelName]) return;
  
  const currentSpeaker = activeSpeakers[channelName] || "";

  // User အားလုံးကို Map လုပ်ပြီး isOnline status ထည့်ပေးခြင်း
  const usersArray = channelUsers[channelName].map(username => ({
    username: username,
    isSpeaking: username === currentSpeaker,
    isOnline: userPresence[channelName]?.[username]?.online || false
  }));

  // Client ဆီသို့ { users: ... } format ဖြင့် ပို့ခြင်း
  io.to(channelName).emit('update_user_list', { users: usersArray });
  io.to(channelName).emit('users_list', { users: usersArray });
}

function emitUserJoined(channelName, username) {
  io.to(channelName).emit('user_joined', { username: username });
}

function emitUserLeft(channelName, username) {
  io.to(channelName).emit('user_left', { username: username });
}

io.on('connection', (socket) => {
  console.log(`[CONNECTED] Socket ID: ${socket.id}`);

  socket.on('join_channel', (data) => {
    try {
      const parsedData = parseData(data);
      if (!parsedData) return;

      const { channelName, password, username } = parsedData;

      if (channelName === ALLOWED_CHANNEL && password === ALLOWED_PASSWORD) {
        
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        if (!channelUsers[channelName]) channelUsers[channelName] = [];
        if (!userPresence[channelName]) userPresence[channelName] = {};

        // User ကိုစာရင်းသွင်းပြီး online status ကို true ပေးခြင်း
        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        channelUsers[channelName].push(username);
        userPresence[channelName][username] = { online: true, socketId: socket.id };

        socket.emit('join_result', { success: true, message: `Connected to ${channelName}`, channelName, username });

        emitUsersList(channelName);
        emitUserJoined(channelName, username);

        console.log(`[JOINED] '${username}' joined channel '${channelName}'`);
      } else {
        socket.emit('join_result', { success: false, message: "Access Denied!" });
      }
    } catch (err) { console.error('Error in join_channel:', err.message); }
  });

  socket.on('request_talk', (data) => {
    try {
      const parsedData = parseData(data) || {};
      const channelName = parsedData.channelName || socket.channelName;
      const username = parsedData.username || socket.username;

      if (!channelName || !username) return;

      if (!activeSpeakers[channelName] || activeSpeakers[channelName] === username) {
        activeSpeakers[channelName] = username;
        socket.emit('talk_granted');
        io.to(channelName).emit('floor_status', { isBusy: true, speaker: username });
        emitUsersList(channelName);
      } else {
        socket.emit('talk_denied', { message: `Channel is busy.` });
      }
    } catch (err) { console.error('Error in request_talk:', err.message); }
  });

  socket.on('stop_talk', (data) => {
    try {
      const parsedData = parseData(data) || {};
      const channelName = parsedData.channelName || socket.channelName;
      const username = parsedData.username || socket.username;

      if (channelName && (!activeSpeakers[channelName] || activeSpeakers[channelName] === username)) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
        emitUsersList(channelName);
      }
    } catch (err) { console.error('Error in stop_talk:', err.message); }
  });

  socket.on('send_audio', (data) => {
    try {
      const parsedData = parseData(data);
      if (!parsedData) return;
      socket.to(parsedData.channelName || socket.channelName).emit('receive_audio', parsedData);
    } catch (err) { console.error('Error in send_audio:', err.message); }
  });

  socket.on('disconnecting', () => {
    const { channelName, username } = socket;

    if (channelName && username) {
      if (activeSpeakers[channelName] === username) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
      }

      // Disconnect ဖြစ်သွားရင် online ကို false လုပ်လိုက်ရုံပဲ
      if (userPresence[channelName] && userPresence[channelName][username]) {
        userPresence[channelName][username].online = false;
      }

      emitUserLeft(channelName, username);
      emitUsersList(channelName); // List ပြန်ပို့ပေး (အခုဆို Offline နဲ့ပြမယ်)
      console.log(`[DISCONNECTED] '${username}' left channel '${channelName}'`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> WTALK Server running on port ${PORT}`);
});
