const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000,
  pingInterval: 25000
});

const CHANNELS = {
  "Quarkofficial9": "quarkmemberonly9"
};

const activeSpeakers = {};
const channelUsers = {}; // Channel တစ်ခုချင်းစီအလိုက် Online ရှိနေသူများ စာရင်း

app.get('/', (req, res) => {
  res.send("Walkie-Talkie Audio Server with Active Users List is Running!");
});

io.on('connection', (socket) => {

  // Channel ထဲသို့ ဝင်ရောက်ခြင်း
  socket.on('join_channel', (data) => {
    try {
      const channelName = data.channelName;
      const password = data.password;
      const username = data.username;

      if (CHANNELS[channelName] && CHANNELS[channelName] === password) {
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        // Channel user list ထဲသို့ ထည့်မည်
        if (!channelUsers[channelName]) {
          channelUsers[channelName] = [];
        }

        // နာမည်တူ မရှိစေရန် အရင်ဖယ်ပြီးမှ ထည့်မည်
        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        channelUsers[channelName].push(username);

        socket.emit('join_result', { success: true, message: `Connected to ${channelName}` });

        // App ဘက်သို့ 'online_users' event ဖြင့် Array ပို့ပေးခြင်း
        io.to(channelName).emit('online_users', channelUsers[channelName]);

        // Active Speaker အခြေအနေ ပို့မည်
        if (activeSpeakers[channelName]) {
          socket.emit('floor_status', { isBusy: true, speaker: activeSpeakers[channelName] });
        } else {
          socket.emit('floor_status', { isBusy: false, speaker: "" });
        }

      } else {
        socket.emit('join_result', { success: false, message: "Invalid Channel or Password!" });
      }
    } catch (err) {
      console.error(err);
    }
  });

  // စကားပြောခွင့် တောင်းဆိုခြင်း
  socket.on('request_talk', (data) => {
    const channelName = data.channelName;
    const username = data.username;

    if (!activeSpeakers[channelName]) {
      activeSpeakers[channelName] = username;
      socket.emit('talk_granted');
      io.to(channelName).emit('floor_status', { isBusy: true, speaker: username });
    } else {
      socket.emit('talk_denied');
    }
  });

  // စကားပြောခြင်း ရပ်တန့်ခြင်း
  socket.on('stop_talk', (data) => {
    const channelName = data.channelName;
    delete activeSpeakers[channelName];
    io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
  });

  // Audio Streaming ပို့ပေးခြင်း
  socket.on('send_audio', (data) => {
    try {
      if (data && data.channelName) {
        socket.to(data.channelName).emit('receive_audio', data);
      }
    } catch (err) {
      console.error(err);
    }
  });

  // 💌 Offline/User ထံ Notification/Nudge ပို့သည့် Event
  socket.on('send_nudge_notification', (data) => {
    try {
      const { channelName, targetUser, fromUser } = data;
      // Channel ထဲရှိ အခြား User များဆီသို့ Nudge Event Broadcast လုပ်ပေးမည်
      socket.to(channelName).emit('receive_nudge', {
        targetUser: targetUser,
        fromUser: fromUser,
        message: `${fromUser} က သင့်ကို စကားပြောချင်လို့ ခေါ်နေပါတယ်! 💌`
      });
    } catch (err) {
      console.error(err);
    }
  });

  // User ထွက်သွားပါက စာရင်းမှ ဖျက်ပြီး Update ပြန်ပို့ပေးခြင်း
  socket.on('disconnecting', () => {
    const channelName = socket.channelName;
    const username = socket.username;

    if (channelName) {
      if (activeSpeakers[channelName] === username) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
      }

      if (channelUsers[channelName] && username) {
        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        // ထွက်သွားပြီးနောက် ကျန်ရှိသူများထံ စာရင်းသစ် ပြန်ပို့ပေးမည်
        io.to(channelName).emit('online_users', channelUsers[channelName]);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> Server running on port ${PORT}`);
});
