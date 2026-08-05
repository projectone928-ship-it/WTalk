const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());

// Firebase Admin SDK ကို Initialize လုပ်ခြင်း
try {
  const serviceAccount = require('./serviceAccountKey.json');
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
const channelUsers = {}; 
const userFcmTokens = {}; 

app.get('/', (req, res) => {
  res.send("Walkie-Talkie Audio Server with FCM Push Notifications is Running!");
});

io.on('connection', (socket) => {

  // FCM Token သိမ်းဆည်းခြင်း Event
  socket.on('register_fcm_token', (data) => {
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      if (parsedData && parsedData.username && parsedData.fcmToken) {
        userFcmTokens[parsedData.username] = parsedData.fcmToken;
        console.log(`Registered FCM Token for ${parsedData.username}`);
      }
    } catch (err) {
      console.error('Error in register_fcm_token:', err);
    }
  });

  // Channel ထဲသို့ ဝင်ရောက်ခြင်း
  socket.on('join_channel', async (data) => {
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      const { channelName, password, username, fcmToken } = parsedData;

      if (CHANNELS[channelName] && CHANNELS[channelName] === password) {
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        if (fcmToken) {
          userFcmTokens[username] = fcmToken;

          // FCM Topic သို့ Auto Subscribe လုပ်ပေးခြင်း (Token ပျောက်သွားရင်တောင် Topic နဲ့ မပျောက်အောင်)
          try {
            await admin.messaging().subscribeToTopic(fcmToken, channelName);
            console.log(`Subscribed ${username} to FCM Topic: ${channelName}`);
          } catch (subErr) {
            console.error("Error subscribing to topic:", subErr);
          }
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
      console.error('Error in join_channel:', err);
    }
  });

  // စကားပြောခွင့် တောင်းဆိုခြင်း
  socket.on('request_talk', (data) => {
    const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
    const { channelName, username } = parsedData;

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
    const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
    const channelName = parsedData.channelName;
    delete activeSpeakers[channelName];
    io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
  });

  // Audio Streaming ပို့ပေးခြင်း
  socket.on('send_audio', (data) => {
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      if (parsedData && parsedData.channelName) {
        socket.to(parsedData.channelName).emit('receive_audio', parsedData);
      }
    } catch (err) {
      console.error(err);
    }
  });

  // 💌 FCM Push Notification ဖြင့် Nudge ပို့သည့် အဓိက အပိုင်း
  socket.on('send_nudge_notification', async (data) => {
    try {
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      const { channelName, targetUser, fromUser, targetFcmToken } = parsedData;

      // Socket Online ရှိနေသူများအတွက် Direct Socket
      socket.to(channelName).emit('receive_nudge_notification', {
        targetUser: targetUser,
        fromUser: fromUser,
        channelName: channelName
      });

      // App ပိတ်ထားသူ/Offline ဖြစ်နေသူများအတွက် FCM Direct Push Notification
      const tokenToSend = targetFcmToken || userFcmTokens[targetUser];

      if (tokenToSend) {
        const payload = {
          token: tokenToSend,
          notification: {
            title: "WTalk Notification 💌",
            body: `${fromUser} is calling you on channel ${channelName}!`
          },
          data: {
            channelName: channelName || "",
            fromUser: fromUser || "",
            type: "nudge"
          },
          android: {
            priority: "high",
            notification: {
              sound: "default",
              channelId: "wtalk_nudge_channel",
              priority: "high"
            }
          }
        };

        const response = await admin.messaging().send(payload);
        console.log("Successfully sent Direct FCM Push Notification:", response);
      } else {
        // Token ရှာမတွေ့ပါက Topic သို့ Broadcast လုပ်သည့် Fallback
        console.log(`No direct FCM token for ${targetUser}. Sending via Topic fallback...`);
        
        const topicPayload = {
          topic: channelName,
          notification: {
            title: "WTalk Notification 💌",
            body: `${fromUser} is calling on channel ${channelName}!`
          },
          data: {
            channelName: channelName || "",
            fromUser: fromUser || "",
            type: "nudge"
          },
          android: {
            priority: "high",
            notification: {
              sound: "default",
              channelId: "wtalk_nudge_channel",
              priority: "high"
            }
          }
        };

        const topicResponse = await admin.messaging().send(topicPayload);
        console.log("Successfully sent Topic FCM Push Notification:", topicResponse);
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
