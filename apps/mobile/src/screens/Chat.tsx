import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAccessProbe, type HouseholdSummary } from '../lib/households';
import {
  EDIT_WINDOW_MS,
  MAX_VOICE_DURATION_MS,
  type OutboxItem,
  type TimelineItem,
  useHouseholdChat,
} from '../lib/chat';
import { useAuth } from '@clerk/expo';
import { Loading, Message, colors } from '../components/ui';

/**
 * Household Chat (issue 04 — text chat; ticket 06 — photo and voice notes).
 *
 * For a Member this screen is a header action pushed over the current
 * destination; back returns to that destination. For a Cook this is the
 * default destination after selecting a Household. In both shells the timeline
 * is one shared, server-ordered conversation that combines human messages and
 * safely rendered attributed system events (issue 06).
 *
 * This screen owns:
 * - the server-ordered timeline (forward-cursor polling + pull-to-refresh);
 * - a Household-scoped text outbox that shows Sending / Sent / Failed and is
 *   never visible to others before server acceptance;
 * - edit and delete of the caller's own messages within the 15-minute window;
 * - the private last-read position, which is updated when Chat is open and the
 *   newest item is visible (never exposed as a read receipt).
 */
export function ChatScreen({
  household,
  onBack,
  backLabel,
}: {
  household: HouseholdSummary;
  onBack: () => void;
  backLabel: string;
}) {
  const { revoked, membershipId } = useAccessProbe(household.id);
  const isCook = household.role === 'cook';
  const { getToken } = useAuth();

  // Mark-read is best-effort when the newest item is actually visible on
  // screen. We track the visible item IDs via FlatList's onViewableItemsChanged
  // and only advance the read cursor when the newest human message is among
  // them — never just because Chat is open (issue 06 — opening a long
  // conversation must not advance unread position past unseen messages).
  const markedRef = useRef<string | null>(null);
  const visibleIdsRef = useRef<Set<string>>(new Set());
  // An inline upload error message, shown above the composer until dismissed
  // (ticket 06, AC#1 — a failed upload cannot be silently swallowed).
  const [uploadError, setUploadError] = useState<string | null>(null);

  const chat = useHouseholdChat(household.id, membershipId);

  // The last human message drives the read position, not the last event.
  const newestMessageId = chat.items.findLast((t) => t.kind === 'message')?.id;

  // Check whether the newest human message is currently visible and, if so,
  // advance the read cursor. Called after viewability changes and when new
  // items arrive.
  const maybeMarkRead = useCallback(() => {
    if (!newestMessageId || !membershipId) return;
    if (markedRef.current === newestMessageId) return;
    if (!visibleIdsRef.current.has(newestMessageId)) return;
    markedRef.current = newestMessageId;
    void chat.markRead(newestMessageId);
  }, [chat, membershipId, newestMessageId]);

  // Re-check whenever the newest message changes (e.g. a poll brought new
  // items). The actual mark-read only fires if that message is visible.
  useEffect(() => {
    maybeMarkRead();
  }, [maybeMarkRead]);

  // A removed participant exits immediately with a plain explanation (issue 06,
  // AC#19 — removed participants immediately lose Chat access).
  if (revoked)
    return (
      <Message
        title="Access changed"
        body={`You no longer have access to ${household.name}. Ask the household owner to invite you again.`}
      />
    );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
    >
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
          <Text style={styles.backLink}>‹ {backLabel}</Text>
        </Pressable>
        <Text style={styles.headerName} numberOfLines={1}>
          {household.name}
        </Text>
      </View>
      {isCook ? <CookFocus household={household} /> : null}
      <FlatList<TimelineItem>
        data={chat.items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TimelineRow
            item={item}
            ownMembershipId={membershipId}
            onEdit={chat.edit}
            onDelete={chat.remove}
            onCorrectTranscript={chat.correctTranscript}
            onEditCaption={chat.editCaption}
            mediaUrl={chat.mediaUrl}
            resolveToken={getToken}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.gap} />}
        contentContainerStyle={styles.list}
        refreshing={chat.loading}
        onRefresh={chat.refresh}
        ListEmptyComponent={
          chat.loading ? (
            <Loading />
          ) : chat.error ? (
            <Text style={styles.hint}>{chat.error}</Text>
          ) : (
            <Text style={styles.hint}>No messages yet. Say hello to {household.name}.</Text>
          )
        }
        onEndReachedThreshold={0.2}
        onViewableItemsChanged={({ viewableItems }) => {
          visibleIdsRef.current = new Set(viewableItems.map((v) => v.key));
          maybeMarkRead();
        }}
        viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
      />
      {uploadError ? (
        <View style={styles.uploadErrorBox}>
          <Text style={styles.uploadErrorText}>{uploadError}</Text>
          <Pressable
            accessibilityRole="button"
            style={styles.minorButton}
            onPress={() => setUploadError(null)}
          >
            <Text style={styles.minorButtonText}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}
      <Outbox items={chat.outbox} onRetry={chat.retry} onCancel={chat.cancel} />
      <Composer
        disabled={!membershipId}
        onSend={(body) => {
          void chat.send(body);
        }}
        onSendPhoto={(data, contentType, caption) => {
          void (async () => {
            try {
              const ref = await chat.uploadMedia('photo', data, contentType);
              await chat.sendPhoto(ref, caption);
            } catch (err) {
              // A failed upload or send is surfaced to the user through the
              // outbox. The sendPhoto/sendVoice helpers create an outbox row
              // only when they run; an upload failure before that point is
              // reported inline so it is never silently swallowed (ticket 06,
              // AC#1/6).
              setUploadError(
                err instanceof Error ? err.message : 'Photo upload failed. Try again.',
              );
            }
          })();
        }}
        onSendVoice={(data, contentType, durationMs) => {
          void (async () => {
            try {
              const ref = await chat.uploadMedia('voice', data, contentType);
              await chat.sendVoice(ref, durationMs);
            } catch (err) {
              setUploadError(
                err instanceof Error ? err.message : 'Voice upload failed. Try again.',
              );
            }
          })();
        }}
      />
    </KeyboardAvoidingView>
  );
}

/**
 * The Cook's pinned focus card (issue 03 — Today's cooking lives at the top of
 * Chat, not as a fourth destination). Opens the Daily Cook View in a later
 * ticket; here it stays a non-interactive summary so the layout is real today.
 */
function CookFocus({ household }: { household: HouseholdSummary }) {
  return (
    <View style={styles.cookCard}>
      <Text style={styles.eyebrow}>Today's cooking</Text>
      <Text style={styles.hint}>
        The confirmed meals for {household.name} today, with Recipe Guides.
      </Text>
    </View>
  );
}

function TimelineRow({
  item,
  ownMembershipId,
  onEdit,
  onDelete,
  onCorrectTranscript,
  onEditCaption,
  mediaUrl,
  resolveToken,
}: {
  item: TimelineItem;
  ownMembershipId: string | null;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onCorrectTranscript: (id: string, correctedText: string) => Promise<unknown>;
  onEditCaption: (id: string, caption: string) => Promise<unknown>;
  mediaUrl: (mediaRef: string) => string;
  resolveToken: () => Promise<string | null>;
}) {
  if (item.kind === 'event') return <EventRow item={item} />;
  return (
    <MessageRow
      item={item}
      isOwn={Boolean(ownMembershipId) && item.senderId === ownMembershipId}
      onEdit={onEdit}
      onDelete={onDelete}
      onCorrectTranscript={onCorrectTranscript}
      onEditCaption={onEditCaption}
      mediaUrl={mediaUrl}
      resolveToken={resolveToken}
    />
  );
}

function MessageRow({
  item,
  isOwn,
  onEdit,
  onDelete,
  onCorrectTranscript,
  onEditCaption,
  mediaUrl,
  resolveToken,
}: {
  item: Extract<TimelineItem, { kind: 'message' }>;
  isOwn: boolean;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onCorrectTranscript: (id: string, correctedText: string) => Promise<unknown>;
  onEditCaption: (id: string, caption: string) => Promise<unknown>;
  mediaUrl: (mediaRef: string) => string;
  resolveToken: () => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.body ?? item.caption ?? '');
  const [showTranscript, setShowTranscript] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [transcriptDraft, setTranscriptDraft] = useState(item.transcriptText ?? '');
  const [imageToken, setImageToken] = useState<string | null>(null);

  // Resolve the auth token once for authorized image loading (ticket 06,
  // AC#3 — media is only accessible through authorized access).
  useEffect(() => {
    if (item.messageKind === 'photo' && item.mediaRef) {
      void resolveToken().then((t) => setImageToken(t));
    }
  }, [item.messageKind, item.mediaRef, resolveToken]);

  // The 15-minute window is enforced on the server; the client hides the
  // controls once it has clearly passed so a user is not offered an action
  // that will be rejected (issue 06, AC#11).
  const withinWindow = useMemo(() => {
    if (!item.editedAt && !item.serverCreatedAt) return false;
    const accepted = new Date(item.serverCreatedAt).getTime();
    return Date.now() - accepted < EDIT_WINDOW_MS;
  }, [item.editedAt, item.serverCreatedAt]);

  if (item.deletedAt) {
    return (
      <View
        style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleTheirs, styles.tombstone]}
      >
        <Text style={styles.tombstoneText}>Message deleted</Text>
      </View>
    );
  }

  const senderLabel = item.sender
    ? `${roleLabel(item.sender.role)} · ${item.sender.displayName}${
        item.sender.active ? '' : ' · left'
      }`
    : 'Someone';

  async function commitEditText() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (item.messageKind === 'text') await onEdit(item.id, trimmed);
    setEditing(false);
  }

  async function commitEditCaption() {
    const trimmed = draft.trim();
    await onEditCaption(item.id, trimmed);
    setEditing(false);
  }

  async function commitTranscriptCorrection() {
    const trimmed = transcriptDraft.trim();
    if (!trimmed) return;
    await onCorrectTranscript(item.id, trimmed);
    setCorrecting(false);
  }

  // ---- Photo message ----
  if (item.messageKind === 'photo') {
    return (
      <View style={isOwn ? styles.rowOwn : styles.rowTheirs}>
        {!isOwn ? <Text style={styles.sender}>{senderLabel}</Text> : null}
        {item.mediaRef ? (
          <Image
            source={{
              uri: mediaUrl(item.mediaRef),
              headers: { Authorization: `Bearer ${imageToken ?? ''}` },
            }}
            style={styles.photo}
            accessibilityLabel="Photo from household chat"
            resizeMode="cover"
          />
        ) : null}
        {editing ? (
          <View style={styles.editBox}>
            <TextInput
              accessibilityLabel="Edit caption"
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Add a caption"
              placeholderTextColor={colors.inkSoft}
              autoFocus
            />
            <View style={styles.editActions}>
              <Pressable
                accessibilityRole="button"
                style={styles.minorButton}
                onPress={() => {
                  setDraft(item.caption ?? '');
                  setEditing(false);
                }}
              >
                <Text style={styles.minorButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={styles.minorButtonPrimary}
                onPress={commitEditCaption}
              >
                <Text style={styles.minorButtonPrimaryText}>Save</Text>
              </Pressable>
            </View>
          </View>
        ) : item.caption ? (
          <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleTheirs]}>
            <Text style={isOwn ? styles.bubbleOwnText : styles.bubbleTheirsText}>
              {item.caption}
            </Text>
            {item.editedAt ? <Text style={styles.meta}>Edited</Text> : null}
          </View>
        ) : null}
        {isOwn && withinWindow ? (
          <View style={styles.ownActions}>
            <Pressable
              accessibilityRole="button"
              style={styles.minorButton}
              onPress={() => {
                setDraft(item.caption ?? '');
                setEditing(true);
              }}
            >
              <Text style={styles.minorButtonText}>Edit caption</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.minorButton}
              onPress={() => {
                void onDelete(item.id);
              }}
            >
              <Text style={styles.minorButtonText}>Delete</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  // ---- Voice message ----
  if (item.messageKind === 'voice') {
    const transcript = item.transcript;
    const isPending = transcript?.status === 'pending';
    const isFailed = transcript?.status === 'failed';
    return (
      <View style={isOwn ? styles.rowOwn : styles.rowTheirs}>
        {!isOwn ? <Text style={styles.sender}>{senderLabel}</Text> : null}
        <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleTheirs]}>
          <View style={styles.voiceRow}>
            <Text style={styles.voiceGlyph}>🎤</Text>
            <Text style={isOwn ? styles.bubbleOwnText : styles.bubbleTheirsText}>Voice note</Text>
          </View>
          {isPending ? (
            <Text style={styles.meta}>Transcribing…</Text>
          ) : isFailed ? (
            <Text style={styles.meta}>Transcript unavailable</Text>
          ) : null}
          {showTranscript && !correcting && item.transcriptText ? (
            <View style={styles.transcriptBox}>
              <Text style={styles.transcriptText}>{item.transcriptText}</Text>
              {item.transcriptAutomatic ? (
                <Text style={styles.transcriptLabel}>Automatic · may need correction</Text>
              ) : null}
            </View>
          ) : null}
          {correcting ? (
            <View style={styles.editBox}>
              <TextInput
                accessibilityLabel="Correct transcript"
                style={styles.input}
                value={transcriptDraft}
                onChangeText={setTranscriptDraft}
                multiline
                autoFocus
              />
              <View style={styles.editActions}>
                <Pressable
                  accessibilityRole="button"
                  style={styles.minorButton}
                  onPress={() => {
                    setTranscriptDraft(item.transcriptText ?? '');
                    setCorrecting(false);
                  }}
                >
                  <Text style={styles.minorButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={styles.minorButtonPrimary}
                  onPress={commitTranscriptCorrection}
                >
                  <Text style={styles.minorButtonPrimaryText}>Save</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
        {!correcting && item.transcriptText ? (
          <View style={styles.ownActions}>
            <Pressable
              accessibilityRole="button"
              style={styles.minorButton}
              onPress={() => setShowTranscript((v) => !v)}
            >
              <Text style={styles.minorButtonText}>
                {showTranscript ? 'Hide transcript' : 'View transcript'}
              </Text>
            </Pressable>
            {isOwn && withinWindow ? (
              <Pressable
                accessibilityRole="button"
                style={styles.minorButton}
                onPress={() => {
                  setTranscriptDraft(item.transcriptText ?? '');
                  setCorrecting(true);
                }}
              >
                <Text style={styles.minorButtonText}>Correct</Text>
              </Pressable>
            ) : null}
            {isOwn && withinWindow ? (
              <Pressable
                accessibilityRole="button"
                style={styles.minorButton}
                onPress={() => {
                  void onDelete(item.id);
                }}
              >
                <Text style={styles.minorButtonText}>Delete</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  // ---- Text message ----
  return (
    <View style={isOwn ? styles.rowOwn : styles.rowTheirs}>
      {!isOwn ? <Text style={styles.sender}>{senderLabel}</Text> : null}
      {editing ? (
        <View style={styles.editBox}>
          <TextInput
            accessibilityLabel="Edit message"
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            autoFocus
          />
          <View style={styles.editActions}>
            <Pressable
              accessibilityRole="button"
              style={styles.minorButton}
              onPress={() => {
                setDraft(item.body ?? '');
                setEditing(false);
              }}
            >
              <Text style={styles.minorButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.minorButtonPrimary}
              onPress={commitEditText}
            >
              <Text style={styles.minorButtonPrimaryText}>Save</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleTheirs]}>
          <Text style={isOwn ? styles.bubbleOwnText : styles.bubbleTheirsText}>{item.body}</Text>
          {item.editedAt ? <Text style={styles.meta}>Edited</Text> : null}
        </View>
      )}
      {isOwn && withinWindow && !editing ? (
        <View style={styles.ownActions}>
          <Pressable
            accessibilityRole="button"
            style={styles.minorButton}
            onPress={() => {
              setDraft(item.body ?? '');
              setEditing(true);
            }}
          >
            <Text style={styles.minorButtonText}>Edit</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.minorButton}
            onPress={() => {
              void onDelete(item.id);
            }}
          >
            <Text style={styles.minorButtonText}>Delete</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function EventRow({ item }: { item: Extract<TimelineItem, { kind: 'event' }> }) {
  const actor = item.actor
    ? `${roleLabel(item.actor.role)} · ${item.actor.displayName}${item.actor.active ? '' : ' · left'}`
    : null;
  return (
    <View style={styles.event}>
      <Text style={styles.eventText}>{item.text}</Text>
      {actor ? <Text style={styles.eventActor}>{actor}</Text> : null}
    </View>
  );
}

/**
 * The Household-scoped outbox. A pending item is local-only and never enters
 * the shared timeline; it shows Sending, Sent, or Failed (issue 06, AC#12).
 * Sent rows retire quickly; failed rows offer Retry or Cancel.
 */
function Outbox({
  items,
  onRetry,
  onCancel,
}: {
  items: OutboxItem[];
  onRetry: (localId: string) => void;
  onCancel: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.outbox}>
      {items.map((row) => (
        <View key={row.localId} style={styles.outboxRow}>
          <Text style={styles.outboxBody} numberOfLines={2}>
            {row.kind === 'photo' ? '📷 ' : row.kind === 'voice' ? '🎤 ' : ''}
            {row.body}
          </Text>
          {row.state === 'sending' ? (
            <Text style={styles.stateSending}>Sending…</Text>
          ) : row.state === 'failed' ? (
            row.failureReason === 'household_access_changed' ? (
              // A removed membership's queued message fails permanently with the
              // specific "Household access changed" label (issue 06, AC#19); it
              // is not retryable.
              <View style={styles.outboxActions}>
                <Text style={styles.stateFailed}>Household access changed</Text>
                <Pressable
                  accessibilityRole="button"
                  style={styles.minorButton}
                  onPress={() => onCancel(row.localId)}
                >
                  <Text style={styles.minorButtonText}>Dismiss</Text>
                </Pressable>
              </View>
            ) : row.kind === 'text' ? (
              // Only text messages can retry inline; photo and voice require
              // re-upload through the composer (ticket 06, AC#6 — a failed
              // upload cannot create an orphaned visible message).
              <View style={styles.outboxActions}>
                <Pressable
                  accessibilityRole="button"
                  style={styles.minorButtonPrimary}
                  onPress={() => onRetry(row.localId)}
                >
                  <Text style={styles.minorButtonPrimaryText}>Retry</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={styles.minorButton}
                  onPress={() => onCancel(row.localId)}
                >
                  <Text style={styles.minorButtonText}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.outboxActions}>
                <Pressable
                  accessibilityRole="button"
                  style={styles.minorButton}
                  onPress={() => onCancel(row.localId)}
                >
                  <Text style={styles.minorButtonText}>Dismiss</Text>
                </Pressable>
              </View>
            )
          ) : (
            <Text style={styles.stateSent}>Sent</Text>
          )}
        </View>
      ))}
    </View>
  );
}

function Composer({
  disabled,
  onSend,
  onSendPhoto,
  onSendVoice,
}: {
  disabled: boolean;
  onSend: (body: string) => void;
  onSendPhoto: (data: ArrayBuffer, contentType: string, caption: string | null) => void;
  onSendVoice: (data: ArrayBuffer, contentType: string, durationMs: number) => void;
}) {
  const [draft, setDraft] = useState('');
  const [captionDraft, setCaptionDraft] = useState('');
  const [showCaption, setShowCaption] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordMs, setRecordMs] = useState(0);

  // Voice recording timer (ticket 06, AC#2 — bounded at two minutes).
  useEffect(() => {
    if (!recording) return;
    const start = Date.now();
    const handle = setInterval(() => {
      const elapsed = Date.now() - start;
      setRecordMs(elapsed);
      if (elapsed >= MAX_VOICE_DURATION_MS) {
        setRecording(false);
      }
    }, 100);
    return () => clearInterval(handle);
  }, [recording]);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft('');
  }

  function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // Photo capture is handled by the platform image picker (expo-image-picker
  // in a development build). This button triggers the upload flow; the actual
  // capture is wired by the shell when the native module is available. The
  // placeholder sends a deterministic empty photo so the flow is testable
  // without the native module; a real build replaces this with the picker
  // result.
  function pickPhoto() {
    if (disabled) return;
    setShowCaption(true);
  }

  function sendPhotoWithCaption() {
    // In a development build this receives the picker result bytes; the
    // placeholder sends a minimal JPEG so the upload + send flow is exercised.
    const placeholder = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
    onSendPhoto(placeholder as ArrayBuffer, 'image/jpeg', captionDraft.trim() || null);
    setCaptionDraft('');
    setShowCaption(false);
  }

  // Voice recording is handled by expo-audio in a development build. The
  // placeholder creates a minimal audio buffer so the send flow is testable;
  // a real build replaces this with the recorder output.
  function toggleRecording() {
    if (disabled) return;
    if (recording) {
      // Stop and send the recorded voice note.
      const placeholder = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;
      onSendVoice(placeholder as ArrayBuffer, 'audio/webm', recordMs);
      setRecording(false);
      setRecordMs(0);
    } else {
      setRecording(true);
      setRecordMs(0);
    }
  }

  return (
    <View style={styles.composer}>
      {showCaption ? (
        <View style={styles.captionBox}>
          <TextInput
            accessibilityLabel="Photo caption"
            style={styles.input}
            placeholderTextColor={colors.inkSoft}
            placeholder="Add a caption (optional)"
            value={captionDraft}
            onChangeText={setCaptionDraft}
          />
          <View style={styles.editActions}>
            <Pressable
              accessibilityRole="button"
              style={styles.minorButton}
              onPress={() => {
                setShowCaption(false);
                setCaptionDraft('');
              }}
            >
              <Text style={styles.minorButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.minorButtonPrimary}
              onPress={sendPhotoWithCaption}
            >
              <Text style={styles.minorButtonPrimaryText}>Send photo</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.composerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send photo"
            style={[styles.mediaButton, disabled && styles.sendDisabled]}
            disabled={disabled}
            onPress={pickPhoto}
          >
            <Text style={styles.mediaGlyph}>📷</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={recording ? 'Stop recording' : 'Record voice note'}
            style={[styles.mediaButton, recording && styles.recordActive]}
            disabled={disabled}
            onPress={toggleRecording}
          >
            <Text style={styles.mediaGlyph}>{recording ? '⏹' : '🎤'}</Text>
          </Pressable>
          {recording ? (
            <Text style={styles.recordTime}>{formatDuration(recordMs)} / 2:00</Text>
          ) : (
            <TextInput
              accessibilityLabel="Message"
              style={styles.input}
              placeholderTextColor={colors.inkSoft}
              placeholder="Message the household"
              value={draft}
              onChangeText={setDraft}
              editable={!disabled}
              multiline
            />
          )}
          {recording ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              style={[styles.send, (!draft.trim() || disabled) && styles.sendDisabled]}
              disabled={!draft.trim() || disabled}
              onPress={submit}
            >
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'cook') return 'Cook';
  return 'Member';
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    backgroundColor: colors.surface,
  },
  back: { minHeight: 44, justifyContent: 'center' },
  backLink: { color: colors.accent, fontSize: 17, fontWeight: '700' },
  headerName: { fontSize: 18, fontWeight: '700', color: colors.ink, flex: 1 },
  cookCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.accentSoft,
    gap: 2,
  },
  eyebrow: { fontSize: 12, fontWeight: '700', color: colors.brand, textTransform: 'uppercase' },
  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
  gap: { height: 10 },
  rowOwn: { alignItems: 'flex-end' },
  rowTheirs: { alignItems: 'flex-start' },
  sender: { fontSize: 12, color: colors.inkSoft, marginBottom: 4, marginLeft: 2 },
  bubble: { maxWidth: '82%', borderRadius: 14, paddingVertical: 9, paddingHorizontal: 13 },
  bubbleOwn: { backgroundColor: colors.accent },
  bubbleOwnText: { color: '#fff', fontSize: 16, lineHeight: 21 },
  bubbleTheirs: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  bubbleTheirsText: { color: colors.ink, fontSize: 16, lineHeight: 21 },
  meta: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 2 },
  tombstone: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  tombstoneText: { color: colors.inkSoft, fontStyle: 'italic' },
  ownActions: { flexDirection: 'row', gap: 6, marginTop: 4 },
  minorButton: {
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: colors.field,
    minHeight: 32,
    justifyContent: 'center',
  },
  minorButtonText: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  minorButtonPrimary: {
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: colors.accent,
    minHeight: 32,
    justifyContent: 'center',
  },
  minorButtonPrimaryText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  editBox: { maxWidth: '82%', gap: 6 },
  editActions: { flexDirection: 'row', gap: 6 },
  event: {
    alignSelf: 'center',
    maxWidth: '90%',
    backgroundColor: colors.field,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 2,
  },
  eventText: { color: colors.ink, fontSize: 13, textAlign: 'center' },
  eventActor: { color: colors.inkSoft, fontSize: 11 },
  outbox: { paddingHorizontal: 16, paddingVertical: 6, backgroundColor: colors.surface },
  outboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 4,
  },
  outboxBody: { flex: 1, color: colors.inkSoft, fontSize: 14, fontStyle: 'italic' },
  outboxActions: { flexDirection: 'row', gap: 6 },
  stateSending: { color: colors.inkSoft, fontSize: 12 },
  stateSent: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  stateFailed: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  uploadErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  uploadErrorText: { flex: 1, color: colors.danger, fontSize: 14 },
  composer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 20,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  captionBox: { gap: 8 },
  mediaButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: colors.field,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaGlyph: { fontSize: 20 },
  recordActive: { backgroundColor: colors.danger },
  recordTime: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: colors.danger,
    textAlign: 'center',
  },
  photo: {
    width: 240,
    height: 180,
    borderRadius: 14,
    backgroundColor: colors.field,
  },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  voiceGlyph: { fontSize: 20 },
  transcriptBox: { marginTop: 6, padding: 8, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.06)' },
  transcriptText: { fontSize: 14, lineHeight: 19, color: colors.ink },
  transcriptLabel: { fontSize: 11, color: colors.inkSoft, marginTop: 4, fontStyle: 'italic' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: colors.card,
    color: colors.ink,
    maxHeight: 120,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 18,
    minHeight: 48,
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  hint: { color: colors.inkSoft, fontSize: 15, padding: 24, textAlign: 'center' },
});
