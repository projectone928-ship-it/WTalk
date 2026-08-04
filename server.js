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

// 🔑 သတ်မှတ်ထားသော Channel Name နှင့် Password
const CHANNELS = {
  "Quarkofficial9": "quarkmemberonly9"
};

// မည်သည့် Channel ထဲတွင် မည်သူ စကားပြောနေသလဲ မှတ်ထားရန်
const activeSpeakers = {};

app.get('/', (req, res) => {
  res.send("Walkie-Talkie Audio Server with Channel Password Control is Running!");
});

io.on('connection', (socket) => {

  // Channel ထဲဝင်ရောက်ခြင်း (Password Verification)
  socket.on('join_channel', (data) => {
    try {
      const channelName = data.channelName;
      const password = data.password;
      const username = data.username;

      // Channel Name နှင့် Password စစ်ဆေးခြင်း
      if (CHANNELS[channelName] && CHANNELS[channelName] === password) {
        
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        // App ဘက်သို့ အောင်မြင်ကြောင်း ပြန်အသိပေးမည်
        socket.emit('join_result', {
          success: true,
          message: `Successfully connected to ${channelName}`
        });

        // လက်ရှိ စကားပြောနေသူရှိပါက ထိုအချက်အလက်ကို ပို့ပေးမည်
        if (activeSpeakers[channelName]) {
          socket.emit('floor_status', { isBusy: true, speaker: activeSpeakers[channelName] });
        } else {
          socket.emit('floor_status', { isBusy: false, speaker: "" });
        }

      } else {
        // Password မှားယွင်းပါက သို့မဟုတ် Channel မရှိပါက ငြင်းပယ်မည်
        socket.emit('join_result', {
          success: false,
          message: "Invalid Channel Name or Password!"
        });
      }

    } catch (err) {
      console.error(err);
      socket.emit('join_result', {
        success: false,
        message: "Server internal error!"
      });
    }
  });

  // စကားစပြောရန် တောင်းဆိုခြင်း (Push-to-Talk)
  socket.on('request_talk', (data) => {
    const channelName = data.channelName;
    const username = data.username;

    if (!activeSpeakers[channelName]) {
      activeSpeakers[channelName] = username;
      socket.emit('talk_granted');
      socket.to(channelName).emit('floor_status', { isBusy: true, speaker: username });
    } else {
      socket.emit('talk_denied');
    }
  });

  // စကားပြောပြီး၍ ခလုတ်လွှတ်လိုက်ခြင်း
  socket.on('stop_talk', (data) => {
    const channelName = data.channelName;
    delete activeSpeakers[channelName];
    io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
  });

  // အသံ Data ပို့ခြင်း
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
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> Audio Server running on port ${PORT}`);
});
