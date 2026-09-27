# WTalk server with Supabase Storage

This backend keeps the existing Socket.IO events and stores Pin Info voice posts outside Render's ephemeral filesystem:

- **Audio files:** private Supabase Storage bucket `wtalk-pin-voices`
- **Metadata and `lastSeenAt`:** Supabase Postgres tables
- **Playback:** the server creates a 120-second signed URL only when `/stream` is requested
- **One post per member:** database unique constraint on `(channel_name, username)`
- **7-day cleanup:** hourly server job deletes inactive users, metadata, and Storage objects

## Supabase setup

1. Create a Supabase project.
2. In Storage, create a **private** bucket named `wtalk-pin-voices`.
3. Open SQL Editor and run `supabase/schema.sql`.
4. Copy the project URL and the server-only `service_role` key.
5. Never put the service-role key in the Android app or GitHub source.

## Render environment variables

Set these in Render → Service → Environment:

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=wtalk-pin-voices
INACTIVE_USER_DAYS=7
MAX_PIN_AUDIO_BYTES=5242880
MAX_PIN_AUDIO_SECONDS=60
CORS_ORIGIN=*
```

The service-role key is a secret. Put it in Render environment variables, not in `.env`, GitHub, or the Android app.

## Deploy

Set the Render service root directory to `server/` (or deploy this folder as its own repository), then use:

```text
Build Command: npm install
Start Command: npm start
```

The Render filesystem is no longer used for permanent voice files. Multer only holds the current upload in memory for the request, then the server uploads it to Supabase Storage.

## API

```text
GET    /health
GET    /api/pin-voices?channelName=...&username=...
POST   /api/pin-voices       multipart/form-data: audio, title, durationSeconds, channelName, username
DELETE /api/pin-voices/:id?channelName=...&username=...
GET    /api/pin-voices/:id/stream?channelName=...&username=...
```

The Android Pin Info UI can keep using the same endpoints. It receives metadata only when listing; Play requests `/stream`, which redirects to a short-lived signed Supabase URL.
