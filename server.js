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

        // User စာရင်းအသစ်ကို Channel ထဲရှိ သူအားလုံးဆီ ပို့မည်
        io.to(channelName).emit('update_user_list', { users: channelUsers[channelName] });

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

  socket.on('stop_talk', (data) => {
    const channelName = data.channelName;
    delete activeSpeakers[channelName];
    io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
  });

  socket.on('send_audio', (data) => {
    try {
      if (data && data.channelName) {
        socket.to(data.channelName).emit('receive_audio', data);
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (activeSpeakers[room]) {
        delete activeSpeakers[room];
        io.to(room).emit('floor_status', { isBusy: false, speaker: "" });
      }

      if (channelUsers[room] && socket.username) {
        channelUsers[room] = channelUsers[room].filter(u => u !== socket.username);
        io.to(room).emit('update_user_list', { users: channelUsers[room] });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> Server running on port ${PORT}`);
});
