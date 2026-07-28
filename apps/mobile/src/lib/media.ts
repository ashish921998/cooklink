import { useCallback, useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import {
  AudioModule,
  RecordingPresets,
  createAudioPlayer,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type AudioPlayer,
  type AudioSource,
} from 'expo-audio';

/**
 * Native media capture for Household Chat (ticket 06 — photo and voice notes).
 *
 * Replaces the deterministic placeholder bytes in the Composer with real
 * Expo-native image selection and audio recording. The server API contract is
 * unchanged: the Composer still calls `uploadMedia(kind, data, contentType)`
 * → `mediaRef` → `sendPhoto` / `sendVoice`.
 *
 * Photo: uses `expo-image-picker` with `base64: true` so the picked image
 * bytes are available without `expo-file-system`. The picker handles the
 * platform permission prompt and cancellation.
 *
 * Voice: uses `expo-audio`'s `useAudioRecorder` hook with the high-quality
 * preset (.m4a / AAC). Recording is bounded at two minutes
 * (`MAX_VOICE_DURATION_MS`). After stopping, the recording can be reviewed
 * via playback before sending.
 */

/** The recording options for voice notes (high-quality .m4a / AAC). */
export const VOICE_RECORDING_OPTIONS = RecordingPresets.HIGH_QUALITY!;

/** Content type for the .m4a container (MPEG-4 audio). */
export const VOICE_CONTENT_TYPE = 'audio/mp4';

export interface PhotoResult {
  data: ArrayBuffer;
  contentType: string;
  width: number;
  height: number;
}

/**
 * Decode a base64 string into an ArrayBuffer. Used for the image picker's
 * `base64` result so we can upload raw bytes without `expo-file-system`.
 */
export function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const chars = atob(base64);
  const bytes = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i++) {
    bytes[i] = chars.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Read a local file URI (e.g. a recording output) as an ArrayBuffer via
 * `fetch`. React Native's networking layer supports `file://` URIs on both
 * iOS and Android.
 */
export async function readFileAsArrayBuffer(uri: string): Promise<ArrayBuffer> {
  const res = await fetch(uri);
  return await res.arrayBuffer();
}

/**
 * Hook for picking a photo from the device media library.
 *
 * Requests `MEDIA_LIBRARY` permission on first use, then launches the system
 * image picker. Returns `null` when the user cancels or permission is denied
 * so the caller can silently abort (ticket 06, AC#1 — a cancelled pick is not
 * an error).
 */
export function usePhotoPicker() {
  const [permissionStatus, setPermissionStatus] = useState<'granted' | 'denied' | 'unknown'>(
    'unknown',
  );

  const pickPhoto = useCallback(async (): Promise<PhotoResult | null> => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setPermissionStatus('denied');
      return null;
    }
    setPermissionStatus('granted');

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.8,
      base64: true,
    });

    if (result.canceled || !result.assets || result.assets.length === 0) {
      return null;
    }

    const asset = result.assets[0];
    if (!asset || !asset.base64) {
      return null;
    }

    return {
      data: decodeBase64ToArrayBuffer(asset.base64),
      contentType: asset.mimeType ?? 'image/jpeg',
      width: asset.width,
      height: asset.height,
    };
  }, []);

  return { pickPhoto, permissionStatus };
}

export type RecorderPhase = 'idle' | 'recording' | 'reviewing';

/**
 * Hook for recording a voice note with `expo-audio`.
 *
 * Manages the full lifecycle: permission request, audio mode setup, start,
 * stop, review, and discard. Recording is bounded at `maxDurationMs`
 * (default: two minutes, ticket 06 AC#2). After stopping, the recording URI
 * is available for review playback and upload.
 */
export function useVoiceRecording(maxDurationMs: number = 2 * 60 * 1000) {
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 100);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  const startRecording = useCallback(async () => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setPermissionDenied(true);
      return false;
    }
    setPermissionDenied(false);

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });

    const rec = recorderRef.current;
    await rec.prepareToRecordAsync();
    rec.record();
    setPhase('recording');
    setDurationMs(0);
    setRecordingUri(null);
    return true;
  }, []);

  const stopRecording = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec.isRecording) return;
    await rec.stop();
    const uri = rec.uri;
    setRecordingUri(uri);
    setPhase('reviewing');

    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: 'mixWithOthers',
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  }, []);

  const discardRecording = useCallback(() => {
    setPhase('idle');
    setRecordingUri(null);
    setDurationMs(0);
  }, []);

  // Track elapsed time from the recorder state for the UI timer.
  useEffect(() => {
    if (phase === 'recording') {
      setDurationMs(recorderState.durationMillis);
    }
  }, [phase, recorderState.durationMillis]);

  // Auto-stop when the bounded duration is reached (ticket 06, AC#2).
  useEffect(() => {
    if (phase !== 'recording') return;
    if (durationMs >= maxDurationMs) {
      void stopRecording();
    }
  }, [durationMs, maxDurationMs, phase, stopRecording]);

  return {
    phase,
    permissionDenied,
    recordingUri,
    durationMs,
    startRecording,
    stopRecording,
    discardRecording,
  };
}

/**
 * Create a transient audio player for reviewing a recording before sending.
 * The caller must call `player.remove()` when done to free resources.
 */
export function createReviewPlayer(uri: string): AudioPlayer {
  return createAudioPlayer(uri as AudioSource);
}
