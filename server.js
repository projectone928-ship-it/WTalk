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

// မည်သည့် Channel ထဲတွင် မည်သူ စကားပြောနေသလဲ မှတ်ထားရန်
const activeSpeakers = {};

app.get('/', (req, res) => {
  res.send("Walkie-Talkie Audio Server with Floor Control is Running!");
});

io.on('connection', (socket) => {

  // Channel ထဲဝင်ရောက်ခြင်း
  socket.on('join_channel', (data) => {
    try {
      const channelName = data.channelName || "Default_Channel";
      socket.join(channelName);
      
      // လက်ရှိ စကားပြောနေသူရှိပါက ထိုအချက်အလက်ကို ပို့ပေးမည်
      if (activeSpeakers[channelName]) {
        socket.emit('floor_status', { isBusy: true, speaker: activeSpeakers[channelName] });
      } else {
        socket.emit('floor_status', { isBusy: false, speaker: "" });
      }
    } catch (err) {
      console.error(err);
    }
  });

  // စကားစပြောရန် တောင်းဆိုခြင်း (Push-to-Talk)
  socket.on('request_talk', (data) => {
    const channelName = data.channelName;
    const username = data.username;

    if (!activeSpeakers[channelName]) {
      // မည်သူမျှ စကားမပြောသေးပါက အခွင့်အရေး ပေးမည်
      activeSpeakers[channelName] = username;
      socket.emit('talk_granted'); // ခွင့်ပြုချက် ရရှိကြောင်း မိမိထံ ပြန်ပို့မည်
      
      // ကျန်သူများဆီသို့ လိုင်းမအားသေးကြောင်း အသိပေးမည်
      socket.to(channelName).emit('floor_status', { isBusy: true, speaker: username });
    } else {
      // အခြားသူ ပြောနေပါက ခွင့်မပြုပါ
      socket.emit('talk_denied');
    }
  });

  // စကားပြောပြီး၍ ခလုတ်လွှတ်လိုက်ခြင်း
  socket.on('stop_talk', (data) => {
    const channelName = data.channelName;
    delete activeSpeakers[channelName];

    // လိုင်းပြန်အားသွားကြောင်း Channel ထဲရှိ သူများဆီ အသိပေးမည်
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
    // လိုင်းပြတ်သွားသူ ပြောနေခဲ့ပါက လိုင်းကို ပြန်ဖွင့်ပေးမည်
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
