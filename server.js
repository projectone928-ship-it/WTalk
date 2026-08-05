const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());

try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log(">>> Firebase Admin Initialized Successfully!");
} catch (error) {
  console.error(">>> Firebase Admin Init Error:", error.message);
}

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e7,
  pingTimeout: 60000,
  pingInterval: 25000
});

const CHANNELS = {
  "Quarkofficial9": "quarkmemberonly9"
};

const activeSpeakers = {};
const channelUsers = {}; // Channel တစ်ခုချင်းစီအလိုက် Online ရှိနေသူများ စာရင်း

app.get('/', (req, res) => {
  res.send("Walkie-Talkie Audio Server is Running!");
});

io.on('connection', (socket) => {

  socket.on('join_channel', async (data) => {
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      const { channelName, password, username, fcmToken } = parsedData;

      if (CHANNELS[channelName] && CHANNELS[channelName] === password) {
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        if (!channelUsers[channelName]) {
          channelUsers[channelName] = [];
        }

        // နာမည်တူ တခြားဟာရှိရင် ဖယ်ပြီး အသစ်ထည့်မည် (Duplicate မဖြစ်စေရန်)
        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        channelUsers[channelName].push(username);

        socket.emit('join_result', { success: true, message: `Connected to ${channelName}` });

        // Channel ထဲရှိသူအားလုံးကို Online Users စာရင်း ပို့ပေးမည်
        io.to(channelName).emit('online_users', channelUsers[channelName]);

      } else {
        socket.emit('join_result', { success: false, message: "Invalid Channel or Password!" });
      }
    } catch (err) {
      console.error('Error in join_channel:', err);
    }
  });

  socket.on('request_talk', (data) => {
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      const channelName = parsedData.channelName || socket.channelName;
      const username = parsedData.username || socket.username;

      if (!channelName) return;

      if (!activeSpeakers[channelName] || activeSpeakers[channelName] === username) {
        activeSpeakers[channelName] = username;
        socket.emit('talk_granted');
        io.to(channelName).emit('floor_status', { isBusy: true, speaker: username });
      } else {
        socket.emit('talk_denied');
      }
    } catch (err) {
      console.error('Error in request_talk:', err);
    }
  });

  socket.on('stop_talk', (data) => {
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      const channelName = parsedData.channelName || socket.channelName;

      if (channelName && activeSpeakers[channelName] === socket.username) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
      }
    } catch (err) {
      console.error('Error in stop_talk:', err);
    }
  });

  socket.on('send_audio', (data) => {
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      const channelName = parsedData.channelName || socket.channelName;

      if (channelName && activeSpeakers[channelName] === socket.username) {
        socket.to(channelName).emit('receive_audio', parsedData);
      }
    } catch (err) {
      console.error('Error in send_audio:', err);
    }
  });

  socket.on('disconnecting', () => {
    const channelName = socket.channelName;
    const username = socket.username;

    if (channelName) {
      if (activeSpeakers[channelName] === username) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
      }

      if (channelUsers[channelName] && username) {
        // ထွက်သွားသူကို Online List ထဲမှ ဖယ်ထုတ်မည်
        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        // ကျန်ရှိနေသူများကို Online Users စာရင်း အသစ်ပြန်ပို့မည်
        io.to(channelName).emit('online_users', channelUsers[channelName]);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> Server running on port ${PORT}`);
});
