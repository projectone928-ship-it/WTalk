const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

function createStorage({ supabaseUrl, serviceRoleKey, bucket = 'wtalk-pin-voices', inactiveDays = 7 }) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const inactiveMs = inactiveDays * 24 * 60 * 60 * 1000;

  async function init() {
    // Create the bucket once in the Supabase Dashboard as a private bucket.
    // The service-role client is intentionally server-only and bypasses RLS.
    const { error } = await supabase.storage.getBucket(bucket);
    if (error) {
      throw new Error(`Supabase bucket check failed: ${error.message}`);
    }
  }

  function publicVoice(voice) {
    if (!voice) return null;
    return {
      id: voice.id,
      channelName: voice.channel_name,
      username: voice.username,
      title: voice.title,
      durationSeconds: voice.duration_seconds,
      fileSize: voice.file_size,
      createdAt: voice.created_at,
      updatedAt: voice.updated_at
    };
  }

  async function touchUser({ channelName, username }) {
    const now = new Date().toISOString();
    const { error } = await supabase.from('wtalk_users').upsert({
      channel_name: channelName,
      username,
      last_seen_at: now
    }, { onConflict: 'channel_name,username' });
    if (error) throw error;
  }

  async function listUsers(channelName) {
    const { data, error } = await supabase
      .from('wtalk_users')
      .select('channel_name, username, last_seen_at')
      .eq('channel_name', channelName);
    if (error) throw error;
    return (data || []).map((user) => ({
      channelName: user.channel_name,
      username: user.username,
      lastSeenAt: user.last_seen_at
    }));
  }

  async function listPinVoices(channelName) {
    const { data, error } = await supabase
      .from('wtalk_pin_voices')
      .select('*')
      .eq('channel_name', channelName)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(publicVoice);
  }

  async function getPinVoice(id) {
    const { data, error } = await supabase
      .from('wtalk_pin_voices')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function createPinVoice({ channelName, username, title, durationSeconds, file }) {
    const id = crypto.randomUUID();
    const extension = file.mimetype === 'audio/mp4' ? 'm4a' : 'bin';
    const storagePath = `${encodeURIComponent(channelName)}/${encodeURIComponent(username)}/${id}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: false
      });
    if (uploadError) throw uploadError;

    const row = {
      id,
      channel_name: channelName,
      username,
      title: title.trim().slice(0, 120),
      duration_seconds: Number(durationSeconds) || 0,
      file_size: file.size,
      mime_type: file.mimetype || 'application/octet-stream',
      storage_path: storagePath
    };
    const { data, error: insertError } = await supabase
      .from('wtalk_pin_voices')
      .insert(row)
      .select('*')
      .single();
    if (insertError) {
      await supabase.storage.from(bucket).remove([storagePath]);
      if (insertError.code === '23505') {
        const error = new Error('You already have a pinned voice message. Delete it before adding a new one.');
        error.code = 'PIN_VOICE_EXISTS';
        throw error;
      }
      throw insertError;
    }
    return publicVoice(data);
  }

  async function deletePinVoice({ id, channelName, username, isAdmin = false }) {
    const voice = await getPinVoice(id);
    if (!voice || voice.channel_name !== channelName) return false;
    if (!isAdmin && voice.username !== username) {
      const error = new Error('Only the voice post owner or a group admin can delete this post.');
      error.code = 'PIN_VOICE_FORBIDDEN';
      throw error;
    }
    const { error: removeError } = await supabase.storage.from(bucket).remove([voice.storage_path]);
    if (removeError) throw removeError;
    const { error: deleteError } = await supabase.from('wtalk_pin_voices').delete().eq('id', id);
    if (deleteError) throw deleteError;
    return true;
  }

  async function createSignedStreamUrl(voice, expiresIn = 120) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(voice.storage_path, expiresIn);
    if (error) throw error;
    return data.signedUrl;
  }

  async function removeInactiveUsers() {
    const cutoff = new Date(Date.now() - inactiveMs).toISOString();
    const { data: users, error } = await supabase
      .from('wtalk_users')
      .select('channel_name, username, last_seen_at')
      .lt('last_seen_at', cutoff);
    if (error) throw error;
    const removed = [];
    for (const user of users || []) {
      const { data: voices, error: voiceError } = await supabase
        .from('wtalk_pin_voices')
        .select('id, storage_path')
        .eq('channel_name', user.channel_name)
        .eq('username', user.username);
      if (voiceError) throw voiceError;
      const paths = (voices || []).map((voice) => voice.storage_path);
      if (paths.length) {
        const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
        if (removeError) throw removeError;
      }
      const { error: pinDeleteError } = await supabase
        .from('wtalk_pin_voices')
        .delete()
        .eq('channel_name', user.channel_name)
        .eq('username', user.username);
      if (pinDeleteError) throw pinDeleteError;
      const { error: userDeleteError } = await supabase
        .from('wtalk_users')
        .delete()
        .eq('channel_name', user.channel_name)
        .eq('username', user.username);
      if (userDeleteError) throw userDeleteError;
      removed.push({ channelName: user.channel_name, username: user.username });
    }
    return removed;
  }

  return {
    init,
    touchUser,
    listUsers,
    listPinVoices,
    publicVoice,
    createPinVoice,
    deletePinVoice,
    removeInactiveUsers,
    getPinVoice,
    createSignedStreamUrl
  };
}

module.exports = { createStorage };
