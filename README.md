# WTalk server additions

This folder is a drop-in Node.js backend for the existing Android Socket.IO client. It keeps the existing event names (`join_channel`, `update_user_list`, `floor_status`, `talk_granted`, `talk_denied`, `send_audio`, `receive_audio`, and `notify_user`) and adds persistent server-local pinned voice posts.

## What it adds

- Server-local audio files under `UPLOAD_DIR`.
- Metadata in `DATA_DIR/wtalk-state.json`.
- One pinned voice post per `(channelName, username)`.
- A user must delete their existing post before adding a new one.
- List endpoints return metadata only; audio is sent only when `/stream` is requested.
- HTTP Range support for streaming playback.
- `lastSeenAt` is updated at every `join_channel`.
- Users inactive for seven days are removed hourly; their pinned voice files and metadata are removed too.

## Run locally

```bash
cd server
cp .env.example .env
npm install
npm start
```

The Android app currently points at `https://wtalk-n120.onrender.com`. Deploy this server to that hostname (or change the app URL in `MainActivity.kt` and `WalkieService.kt`). The server-local storage policy means files can be lost if the host wipes its filesystem during a redeploy or restart; use a persistent disk if the hosting provider offers one.

## API

All requests identify the caller with `channelName` and `username`. The current Android client has no authentication token, so this is compatible with the existing app but should be upgraded with signed authentication before public production use.

```text
GET    /health
GET    /api/pin-voices?channelName=...&username=...
POST   /api/pin-voices       multipart/form-data: audio, title, durationSeconds, channelName, username
DELETE /api/pin-voices/:id?channelName=...&username=...
GET    /api/pin-voices/:id/stream?channelName=...&username=...
```

For delete, the owner may delete their own post. An admin integration may additionally send `x-wtalk-admin: true` after adding real admin authentication.

## Socket events for the Android feature

The server emits `pin_voice_list` immediately after a successful `join_channel`, and emits `pin_voice_created` / `pin_voice_deleted` to the channel when the REST endpoints change the list. The Android Pin Info UI should load metadata on join, upload only after recording and title confirmation, and create an audio player only after Play is pressed.
