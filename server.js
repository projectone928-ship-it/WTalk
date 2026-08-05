const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e7
});

const CHANNELS = {
    Quarkofficial9: "quarkmemberonly9"
};

// channel တစ်ခုစီရဲ့ speaker
const activeSpeakers = {};

// socket.id => user info
const clients = {};

app.get("/", (req, res) => {
    res.send("WTalk server running");
});

io.on("connection", (socket) => {

    console.log("CONNECTED:", socket.id);

    socket.on("join_channel", (data) => {

        try {

            const {
                channelName,
                password,
                username
            } = data;

            if (!CHANNELS[channelName]) {

                socket.emit("join_result", {
                    success: false,
                    message: "Channel not found"
                });

                return;
            }

            if (CHANNELS[channelName] !== password) {

                socket.emit("join_result", {
                    success: false,
                    message: "Wrong password"
                });

                return;
            }

            socket.join(channelName);

            clients[socket.id] = {
                username,
                channelName,
                canTalk: false
            };

            socket.emit("join_result", {
                success: true,
                message: `Connected to ${channelName}`
            });

            const speaker = activeSpeakers[channelName];

            socket.emit("floor_status", {
                isBusy: !!speaker,
                speaker: speaker || ""
            });

            console.log(username + " joined " + channelName);

        } catch (e) {

            console.log(e);

            socket.emit("join_result", {
                success: false,
                message: "Join failed"
            });
        }
    });

    socket.on("request_talk", () => {

        const user = clients[socket.id];

        if (!user) return;

        const channelName = user.channelName;
        const username = user.username;

        if (!activeSpeakers[channelName]) {

            activeSpeakers[channelName] = username;

            user.canTalk = true;

            socket.emit("talk_granted");

            io.to(channelName).emit("floor_status", {
                isBusy: true,
                speaker: username
            });

            console.log(username + " started talking");

        } else {

            socket.emit("talk_denied");
        }
    });

    socket.on("send_audio", (data) => {

        const user = clients[socket.id];

        if (!user) return;

        const channelName = user.channelName;

        if (!user.canTalk) {
            return;
        }

        if (activeSpeakers[channelName] !== user.username) {
            return;
        }

        socket.to(channelName).emit("receive_audio", {
            username: user.username,
            audioData: data.audioData
        });
    });

    socket.on("stop_talk", () => {

        const user = clients[socket.id];

        if (!user) return;

        const channelName = user.channelName;

        if (activeSpeakers[channelName] === user.username) {

            delete activeSpeakers[channelName];

            user.canTalk = false;

            io.to(channelName).emit("floor_status", {
                isBusy: false,
                speaker: ""
            });

            console.log(user.username + " stopped talking");
        }
    });

    socket.on("disconnect", () => {

        const user = clients[socket.id];

        if (user) {

            const channelName = user.channelName;

            if (activeSpeakers[channelName] === user.username) {

                delete activeSpeakers[channelName];

                io.to(channelName).emit("floor_status", {
                    isBusy: false,
                    speaker: ""
                });
            }

            delete clients[socket.id];

            console.log(user.username + " disconnected");
        }
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
