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
  pingTimeout: 60000,
  pingInterval: 25000
});

// Channel Configuration
const CHANNELS = {
  "Quarkofficial9": "quarkmemberonly9"
};

// State Trackers
const activeSpeakers = {};
const channelUsers = {};
const userPresence = {};
const pendingNotifications = {};

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

// Emit users list to all users in channel
function emitUsersList(channelName) {
  if (!channelUsers[channelName]) return;
  
  const usersArray = channelUsers[channelName].map(username => ({
    username: username,
    isOnline: userPresence[channelName]?.[username]?.online || false
  }));

  const listData = { users: usersArray };
  io.to(channelName).emit('users_list', listData);
}

// Emit user joined to all in channel
function emitUserJoined(channelName, username) {
  io.to(channelName).emit('user_joined', { username: username });
}

// Emit user left to all in channel
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

      // Check channel and password
      if (CHANNELS[channelName] && CHANNELS[channelName] === password) {
        socket.join(channelName);
        socket.username = username;
        socket.channelName = channelName;

        if (!channelUsers[channelName]) {
          channelUsers[channelName] = [];
        }
        if (!userPresence[channelName]) {
          userPresence[channelName] = {};
        }

        // Remove duplicate
        channelUsers[channelName] = channelUsers[channelName].filter(u => u !== username);
        channelUsers[channelName].push(username);
        userPresence[channelName][username] = { online: true, socketId: socket.id };

        socket.emit('join_result', { 
          success: true, 
          message: `Connected to ${channelName}`,
          channelName: channelName,
          username: username
        });

        // Emit users list to everyone
        emitUsersList(channelName);
        
        // Notify others that user joined
        emitUserJoined(channelName, username);

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

  // 2. Request Floor
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

  // 3. Stop Talk
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

  // 4. Send Audio
  socket.on('send_audio', (data) => {
    try {
      const parsedData = parseData(data);
      if (!parsedData) return;

      const channelName = parsedData.channelName || socket.channelName;

      if (channelName && activeSpeakers[channelName] === socket.username) {
        socket.to(channelName).emit('receive_audio', parsedData);
      }
    } catch (err) {
      console.error('Error in send_audio:', err.message);
    }
  });

  // 5. Send Notification
  socket.on('send_notification', (data) => {
    try {
      const parsedData = parseData(data);
      if (!parsedData) return;

      const channelName = parsedData.channelName || socket.channelName;
      const targetUser = parsedData.targetUser || parsedData.targetUsername;

      if (!channelName || !targetUser) return;

      const targetPresence = userPresence[channelName]?.[targetUser];
      if (targetPresence && !targetPresence.online) {
        // User is offline - confirm notification
        socket.emit('notification_sent', {
          success: true,
          targetUser: targetUser
        });
        console.log(`[NOTIFICATION] '${socket.username}' sent notification to '${targetUser}' (offline)`);
      } else if (targetPresence && targetPresence.online) {
        // User is online - send direct message
        const targetSocket = io.sockets.sockets.get(targetPresence.socketId);
        if (targetSocket) {
          targetSocket.emit('notification_received', {
            from: socket.username,
            message: `${socket.username} wants to talk with you`
          });
          socket.emit('notification_sent', {
            success: true,
            targetUser: targetUser
          });
          console.log(`[MESSAGE] '${socket.username}' sent message to '${targetUser}' (online)`);
        }
      } else {
        socket.emit('notification_sent', {
          success: false,
          targetUser: targetUser
        });
      }
    } catch (err) {
      console.error('Error in send_notification:', err.message);
    }
  });

  // 6. Disconnect Handler
  socket.on('disconnecting', () => {
    const channelName = socket.channelName;
    const username = socket.username;

    if (channelName && username) {
      // Release floor if speaking
      if (activeSpeakers[channelName] === username) {
        delete activeSpeakers[channelName];
        io.to(channelName).emit('floor_status', { isBusy: false, speaker: "" });
      }

      // Update presence
      if (userPresence[channelName] && userPresence[channelName][username]) {
        userPresence[channelName][username].online = false;
      }

      // Notify others user left
      emitUserLeft(channelName, username);

      // Update users list
      emitUsersList(channelName);

      console.log(`[DISCONNECTED] '${username}' left channel '${channelName}'`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`>>> WTALK Server running on port ${PORT}`);
});
      
