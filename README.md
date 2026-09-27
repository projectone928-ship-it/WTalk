# WTalk simple Socket.IO server

This is the basic live Push-to-Talk server. It does **not** use Render local disk, Supabase, a database, or voice-file storage.

It provides:

- Socket.IO channel join and online user list
- One-speaker floor control
- Low-latency `send_audio` relay between connected users
- `notify_user` for Come Back/notification behavior
- `/health` endpoint

All channel and online-user state is held in RAM. A restart or deploy clears the live channel list; users can reconnect normally. No Pin Info voice-post API is included in this simple server.

## Render settings

For a server-only GitHub repository:

```text
Root Directory: leave empty
Build Command: npm install
Start Command: npm start
```

For a full Android repository with this folder at `server/`:

```text
Root Directory: server
Build Command: npm install
Start Command: npm start
```

Optional environment variables:

```text
PORT=10000
HOST=0.0.0.0
CORS_ORIGIN=*
```

Render supplies `PORT` automatically, so it is normally not necessary to add it manually.

## Health check

After deployment, open:

```text
https://YOUR-RENDER-URL.onrender.com/health
```

Expected response:

```json
{"ok":true,"service":"wtalk-server"}
```
