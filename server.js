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
  maxHttpBufferSize: 1e7, // 10MB Buffer
  pingTimeout: 30000,
  pingInterval: 10000
});

// 📍 Hardcoded Channel & Password
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
    try {
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }
  return data;
}

function emitUsersList(channelName) {
  if (!channelUsers[channelName]) return;
  
  const currentSpeaker = activeSpeakers[channelName] || "";

  const usersArray = channelUsers[channelName]
    .filter(username => userPresence[channelName]?.[username]?.online)
    .map(username => ({
      username: username,
      isSpeaking: username === currentSpeaker
    }));

  io.to(channelName).emit('update_user_list', usersArray);
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

  // 1. Join Channel
  socket.on('join_channel', (data) => {
    try {
      const parsedData = parseData(data);
      if (!parsedData) return;

      const { channelName, password, username } = parsedData;

      if (channelName === ALLOWED_CHANNEL && password === ALLOWED_PASSWORD) {
        
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        if (!channelUsers[channelName]) {
          channelUsers[channelName] = [];
        }
        if (!userPresence[channelName]) {
          userPresence[channelName] = {};
        }

        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        channelUsers[channelName].push(username);
        userPresence[channelName][username] = { online: true, socketId: socket.id };

        socket.emit('join_result', { 
          success: true, 
          message: `Connected to ${channelName}`,
          channelName: channelName,
          username: username
        });

        emitUsersList(channelName);
        emitUserJoined(channelName, username);

        console.log(`[JOINED] '${username}' joined channel '${channelName}'`);

      } else {
        socket.emit('join_result', { 
          success: false, 
          message: "Access Denied: Invalid Channel Name or Password!" 
        });
        console.log(`[AUTH FAILED] '${username}' failed authentication.`);
      }
    } catch (err) {
      console.error('Error in join_channel:', err.message);
    }
  });

  // 2. Request Floor (စကားပြောခွင့်တောင်းခြင်း)
  socket.on('request_talk', (data) => {
    try {
      const parsedData = parseData(data) || {};
      const channelName = parsedData.channelName || socket.channelName;
      const username = parsedData.username || socket.username;

      if (!channelName || !username) return;

      // လိုင်းလွတ်နေလျှင် (သို့) မိမိကိုယ်တိုင် ပြောနေခြင်းဖြစ်ပါက ချက်ချင်း ခွင့်ပြုမည်
      if (!activeSpeakers[channelName] || activeSpeakers[channelName] === username) {
        activeSpeakers[channelName] = username;
        socket.emit('talk_granted');
        io.to(channelName).emit('floor_status', { isBusy: true, speaker: username });
        
        emitUsersList(channelName);
        console.log(`[FLOOR GRANTED] ${username} is speaking in '${channelName}'`);
      } else {
        socket.emit('talk_denied', { 
          message: `Channel is busy. ${activeSpeakers[channelName]} is speaking.` 
        });
      }
    } catch (err) {
      console.error('Error in request_talk:', err.message);
    }
  });

  // 3. Stop Talk (စကားပြောပြီး၍ လိုင်းပြန်လွှတ်ခြင်း - Busy မကျန်အောင် ပြင်ထားသည်)
  socket.on('stop_talk', (data) => {
    try {
      const parsedData = parseData(data) || {};
      const channelName = parsedData.channelName || socket.channelName;
      const username = parsedData.username || socket.username;

      if (channelName) {
        // Active speaker ဟုတ်မဟုတ် စစ်ပြီး သို့မဟုတ် လိုင်းပွင့်စေရန် အမြဲ Reset လုပ်ပေးမည်
        if (!activeSpeakers[channelName] || activeSpeakers[channelName] === username) {
          delete activeSpeakers[channelName];
          io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
          emitUsersList(channelName);
          console.log(`[FLOOR RELEASED] ${username} stopped speaking in '${channelName}'`);
        }
      }
    } catch (err) {
      console.error('Error in stop_talk:', err.message);
    }
  });

  // 4. Send Audio (အသံဖိုင် Broadcast ပြုလုပ်ခြင်း)
  socket.on('send_audio', (data) => {
    try {
      const parsedData = parseData(data);
      if (!parsedData) return;

      const channelName = parsedData.channelName || socket.channelName;
      const sender = parsedData.username || socket.username;

      if (channelName && sender) {
        if (!activeSpeakers[channelName]) {
          activeSpeakers[channelName] = sender;
        }
        socket.to(channelName).emit('receive_audio', parsedData);
      }
    } catch (err) {
      console.error('Error in send_audio:', err.message);
    }
  });

  // 5. Disconnect Handler
  socket.on('disconnecting', () => {
    const channelName = socket.channelName;
    const username = socket.username;

    if (channelName && username) {
      if (activeSpeakers[channelName] === username) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
      }

      if (userPresence[channelName] && userPresence[channelName][username]) {
        userPresence[channelName][username].online = false;
      }

      emitUserLeft(channelName, username);
      emitUsersList(channelName);

      console.log(`[DISCONNECTED] '${username}' left channel '${channelName}'`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> WTALK Server running on port ${PORT}`);
});
