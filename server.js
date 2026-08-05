const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin'); // 1. Firebase Admin ကို Import လုပ်ပါ

const app = express();
app.use(cors());

// 2. Firebase Admin SDK ကို Initialize လုပ်ခြင်း
// (မှတ်ချက်: Firebase Console > Project Settings > Service Accounts ထဲကနေ ဒေါင်းလုဒ်ဆွဲထားတဲ့ JSON ဖိုင် နာမည် ထည့်ပေးရပါမယ်)
try {
  const serviceAccount = require('./serviceAccountKey.json'); // မင်းရဲ့ Service Account Key ဖိုင်လမ်းကြောင်း
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log(">>> Firebase Admin Initialized Successfully!");
} catch (error) {
  console.error(">>> Firebase Admin Init Error (serviceAccountKey.json ရှိမရှိ စစ်ပါ):", error.message);
}

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
const channelUsers = {}; // Channel အလိုက် Online ရှိသူများ
const userFcmTokens = {}; // User တစ်ယောက်ချင်းစီရဲ့ FCM Token များကို သိမ်းဆည်းရန် Object

app.get('/', (req, res) => {
  res.send("Walkie-Talkie Audio Server with FCM Push Notifications is Running!");
});

io.on('connection', (socket) => {

  // User ရဲ့ FCM Token သိမ်းဆည်းခြင်း Event
  socket.on('register_fcm_token', (data) => {
    if (data && data.username && data.fcmToken) {
      userFcmTokens[data.username] = data.fcmToken;
      console.log(`Registered FCM Token for ${data.username}`);
    }
  });

  // Channel ထဲသို့ ဝင်ရောက်ခြင်း
  socket.on('join_channel', (data) => {
    try {
      const channelName = data.channelName;
      const password = data.password;
      const username = data.username;
      const fcmToken = data.fcmToken; // App ဘက်က FCM Token ပါ ပို့ပေးရပါမယ်

      if (CHANNELS[channelName] && CHANNELS[channelName] === password) {
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        if (fcmToken) {
          userFcmTokens[username] = fcmToken;
        }

        if (!channelUsers[channelName]) {
          channelUsers[channelName] = [];
        }

        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        channelUsers[channelName].push(username);

        socket.emit('join_result', { success: true, message: `Connected to ${channelName}` });
        io.to(channelName).emit('online_users', channelUsers[channelName]);

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

  // 💌 FCM Push Notification ဖြင့် စာ/Nudge ပို့သည့် အဓိက အပိုင်း
  socket.on('send_nudge_notification', async (data) => {
    try {
      const { channelName, targetUser, fromUser, targetFcmToken } = data;

      // Socket Online ရှိနေသူများအတွက် Socket တိုက်ရိုက်ပို့ခြင်း
      socket.to(channelName).emit('receive_nudge', {
        targetUser: targetUser,
        fromUser: fromUser,
        message: `${fromUser} က သင့်ကို စကားပြောချင်လို့ ခေါ်နေပါတယ်! 💌`
      });

      // App ပိတ်ထားသူ/Offline ဖြစ်နေသူများအတွက် FCM Push Notification လှမ်းပို့ပေးခြင်း
      const tokenToSend = targetFcmToken || userFcmTokens[targetUser];

      if (tokenToSend) {
        const payload = {
          token: tokenToSend,
          notification: {
            title: "WTalk Walkie-Talkie 🎙️",
            body: `${fromUser} က သင့်ကို ${channelName} တွင် ခေါ်နေပါတယ်!`
          },
          data: {
            channelName: channelName || "",
            fromUser: fromUser || "",
            type: "nudge"
          },
          android: {
            priority: "high", // High Priority ထည့်မှ App ပိတ်ထားချိန် Noti ပေါ်မည်
            notification: {
              sound: "default",
              channelId: "wtalk_nudge_channel",
              priority: "high"
            }
          }
        };

        const response = await admin.messaging().send(payload);
        console.log("Successfully sent FCM Push Notification:", response);
      } else {
        console.log(`No FCM token found for user: ${targetUser}`);
      }

    } catch (err) {
      console.error("Error sending FCM notification:", err);
    }
  });

  // User ထွက်သွားပါက စာရင်းမှ ဖျက်ခြင်း
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
        io.to(channelName).emit('online_users', channelUsers[channelName]);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> Server running on port ${PORT}`);
});
