const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());

// 📍 Firebase Admin Initializer
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
  maxHttpBufferSize: 1e7, // 10MB Audio Buffer Limit
  pingTimeout: 60000,
  pingInterval: 25000
});

// 📍 Channel Name နှင့် Password သတ်မှတ်ချက်
const CHANNELS = {
  "Quarkofficial9": "quarkmemberonly9"
};

// Floor Control & Online Users Tracker
const activeSpeakers = {}; // { channelName: username }
const channelUsers = {};   // { channelName: [username1, username2, ...] }

app.get('/', (req, res) => {
  res.send("WTALK Walkie-Talkie Audio Server is Running!");
});

// Safe JSON Data Parser
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

io.on('connection', (socket) => {
  console.log(`[CONNECTED] Socket ID: ${socket.id}`);

  // 1. Join Channel
  socket.on('join_channel', (data) => {
    try {
      const parsedData = parseData(data);
      if (!parsedData) return;

      const { channelName, password, username } = parsedData;

      // Channel Name နှင့် Password စစ်ဆေးခြင်း
      if (CHANNELS[channelName] && CHANNELS[channelName] === password) {
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        if (!channelUsers[channelName]) {
          channelUsers[channelName] = [];
        }

        // Duplicate User ဖယ်ထုတ်ပြီး Online List အသစ်ပြန်ပြင်မည်
        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        channelUsers[channelName].push(username);

        socket.emit('join_result', { 
          success: true, 
          message: `Connected to ${channelName}` 
        });

        // Channel အတွင်းရှိသူအားလုံးကို Online List ပို့ပေးမည်
        io.to(channelName).emit('online_users', channelUsers[channelName]);
        console.log(`[JOINED] '${username}' joined channel '${channelName}'`);

      } else {
        socket.emit('join_result', { 
          success: false, 
          message: "Invalid Channel Name or Password!" 
        });
        console.log(`[AUTH FAILED] '${username}' failed authentication for '${channelName}'`);
      }
    } catch (err) {
      console.error('Error in join_channel:', err.message);
    }
  });

  // 2. Request Floor (စကားပြောရန် တောင်းဆိုခြင်း)
  socket.on('request_talk', (data) => {
    try {
      const parsedData = parseData(data) || {};
      const channelName = parsedData.channelName || socket.channelName;
      const username = parsedData.username || socket.username;

      if (!channelName || !username) return;

      // Channel လွတ်နေပါက သို့မဟုတ် မိမိကိုယ်တိုင် ပြောနေခြင်းဖြစ်ပါက Floor ပေးမည်
      if (!activeSpeakers[channelName] || activeSpeakers[channelName] === username) {
        activeSpeakers[channelName] = username;
        socket.emit('talk_granted');
        io.to(channelName).emit('floor_status', { isBusy: true, speaker: username });
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

  // 3. Stop Talk (စကားပြောခြင်း ရပ်နားခြင်း)
  socket.on('stop_talk', (data) => {
    try {
      const parsedData = parseData(data) || {};
      const channelName = parsedData.channelName || socket.channelName;

      if (channelName && activeSpeakers[channelName] === socket.username) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
        console.log(`[FLOOR RELEASED] ${socket.username} stopped speaking in '${channelName}'`);
      }
    } catch (err) {
      console.error('Error in stop_talk:', err.message);
    }
  });

  // 4. Send Audio Stream Data
  socket.on('send_audio', (data) => {
    try {
      const parsedData = parseData(data);
      if (!parsedData) return;

      const channelName = parsedData.channelName || socket.channelName;

      // Active Speaker ဟုတ်မှသာ အခြားသူများထံ အသံ ပို့ပေးမည်
      if (channelName && activeSpeakers[channelName] === socket.username) {
        socket.to(channelName).emit('receive_audio', parsedData);
      }
    } catch (err) {
      console.error('Error in send_audio:', err.message);
    }
  });

  // 5. Cleanup on Disconnect
  socket.on('disconnecting', () => {
    const channelName = socket.channelName;
    const username = socket.username;

    if (channelName) {
      // စကားပြောနေတုန်း Disconnect ဖြစ်သွားပါက Floor ပြန်လွှတ်ပေးမည်
      if (activeSpeakers[channelName] === username) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
      }

      // Online List ထဲမှ ဖယ်ထုတ်ပြီး ကျန်ရှိသူများထံ စာရင်းပြန်ပို့မည်
      if (channelUsers[channelName] && username) {
        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        io.to(channelName).emit('online_users', channelUsers[channelName]);
      }

      console.log(`[DISCONNECTED] '${username}' left channel '${channelName}'`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> WTALK Server running on port ${PORT}`);
});
        
