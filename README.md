# WTalk Socket.IO server

This server implements the event contract used by the Android app, including reliable offline-user notifications.

## Offline notification flow

1. An Android client in the background emits `register_notification` with `channelName`, `password`, and `username`.
2. The sender emits `notify_user` with `targetUsername`, `senderUsername`, `channelName`, `title`, and `message`.
3. If the recipient is connected in notification mode, the server emits `offline_notification` immediately.
4. If the recipient is not connected, the server queues up to 50 messages per username in `data/offline-notifications.json`.
5. On the recipient's next `register_notification`, queued messages are delivered and removed.

## Run

```bash
npm install
npm start
```

Set `PORT` to change the port. Set `WTALK_STORE` to use another queue file location.

## Android endpoint

Update both `MainActivity.kt` and `WalkieService.kt` from:

```text
https://wtalk-n120.onrender.com
```

to the deployed server URL, then rebuild the Android app.

The server must be deployed with a persistent disk or external database if queued notifications must survive a server restart. The included JSON store is suitable for a single-instance deployment with persistent storage.
