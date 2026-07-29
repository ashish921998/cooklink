import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
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
import {
  Avatar,
  Chip,
  Loading,
  Message,
  MiniButton,
  PressableScale,
  colors,
  fonts,
  radius,
  shadow,
  space,
  styles as ui,
} from '../components/ui';
import { Mascot } from '../components/Mascot';
import {
  VOICE_CONTENT_TYPE,
  createReviewPlayer,
  readFileAsArrayBuffer,
  usePhotoPicker,
  useVoiceRecording,
} from '../lib/media';

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
 *
 * Bubbles are deliberately not animated on mount: FlatList recycles rows, so an
 * entrance animation would replay every time a message scrolled back into view.
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
      style={chatStyles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
    >
      <View style={chatStyles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          onPress={onBack}
          style={chatStyles.back}
        >
          <Text style={chatStyles.backChevron}>‹</Text>
        </Pressable>
        <Avatar name={household.name} size={38} />
        <View style={chatStyles.headerText}>
          <Text style={chatStyles.headerName} numberOfLines={1}>
            {household.name}
          </Text>
          <Text style={chatStyles.headerNote}>Household chat</Text>
        </View>
        <Chip
          label={isCook ? 'Cook' : 'Member'}
          tint={isCook ? colors.accentSoft : colors.brandSoft}
          ink={isCook ? colors.accent : colors.brand}
        />
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
        ItemSeparatorComponent={() => <View style={chatStyles.gap} />}
        contentContainerStyle={chatStyles.list}
        refreshing={chat.loading}
        onRefresh={chat.refresh}
        ListEmptyComponent={
          chat.loading ? (
            <Loading />
          ) : chat.error ? (
            <Text style={chatStyles.hint}>{chat.error}</Text>
          ) : (
            <View style={chatStyles.empty}>
              <Mascot size={132} say="Say hello!" />
              <Text style={chatStyles.emptyTitle}>No messages yet</Text>
              <Text style={chatStyles.hint}>
                This is the one conversation shared by {household.name} and its cooks.
              </Text>
            </View>
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
        <View style={chatStyles.uploadErrorBox}>
          <Text style={chatStyles.uploadErrorText}>{uploadError}</Text>
          <MiniButton
            label="Dismiss"
            accessibilityLabel="Dismiss upload error"
            onPress={() => setUploadError(null)}
          />
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
    <View style={chatStyles.cookCard}>
      <View style={chatStyles.cookCardText}>
        <Text style={ui.eyebrow}>Today&apos;s cooking</Text>
        <Text style={chatStyles.cookCardBody}>
          The confirmed meals for {household.name} today, with Recipe Guides.
        </Text>
      </View>
      <Mascot size={68} withPet={false} interactive={false} />
    </View>
  );
}

/** A chat bubble, coloured for own vs others, with an optional "Edited" meta. */
function Bubble({
  isOwn,
  edited,
  children,
}: {
  isOwn: boolean;
  edited?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[chatStyles.bubble, isOwn ? chatStyles.bubbleOwn : chatStyles.bubbleTheirs]}>
      {children}
      {edited ? <Text style={isOwn ? chatStyles.metaOwn : chatStyles.meta}>Edited</Text> : null}
    </View>
  );
}

/** The body text of a bubble, coloured for own vs others. */
function BubbleText({ isOwn, children }: { isOwn: boolean; children: ReactNode }) {
  return (
    <Text style={isOwn ? chatStyles.bubbleOwnText : chatStyles.bubbleTheirsText}>{children}</Text>
  );
}

/** The inline edit affordance shared by message, caption, and transcript edits:
 *  a field plus a Cancel/Save pair. */
function InlineEdit({
  label,
  value,
  onChangeText,
  onCancel,
  onSave,
  placeholder,
  multiline,
  saveDisabled,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  placeholder?: string;
  multiline?: boolean;
  saveDisabled?: boolean;
}) {
  return (
    <View style={chatStyles.editBox}>
      <TextInput
        accessibilityLabel={label}
        style={chatStyles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.inkSoft}
        multiline={multiline}
        autoFocus
      />
      <View style={chatStyles.editActions}>
        <MiniButton label="Cancel" accessibilityLabel={`Cancel ${label}`} onPress={onCancel} />
        <MiniButton
          label="Save"
          primary
          accessibilityLabel={`Save ${label}`}
          disabled={saveDisabled}
          onPress={onSave}
        />
      </View>
    </View>
  );
}

/** The row of inline actions shown under one's own message. */
function OwnActions({ children }: { children: ReactNode }) {
  return <View style={chatStyles.ownActions}>{children}</View>;
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
  // controls once it has clearly passed so a user is not offered an action that
  // will be rejected (issue 06, AC#11). A timer flips `expired` exactly when the
  // window closes, so a row that stays mounted stops offering the action on time
  // rather than freezing whatever `Date.now()` read at first render.
  const acceptedAt = new Date(item.serverCreatedAt).getTime();
  const [expired, setExpired] = useState(Date.now() - acceptedAt >= EDIT_WINDOW_MS);
  useEffect(() => {
    const remaining = acceptedAt + EDIT_WINDOW_MS - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const id = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(id);
  }, [acceptedAt]);
  const withinWindow = !expired;

  if (item.deletedAt) {
    return (
      <View
        style={[
          chatStyles.bubble,
          isOwn ? chatStyles.bubbleOwn : chatStyles.bubbleTheirs,
          chatStyles.tombstone,
        ]}
      >
        <Text style={chatStyles.tombstoneText}>Message deleted</Text>
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
      <View style={isOwn ? chatStyles.rowOwn : chatStyles.rowTheirs}>
        {!isOwn ? <Text style={chatStyles.sender}>{senderLabel}</Text> : null}
        {item.mediaRef ? (
          <Image
            source={{
              uri: mediaUrl(item.mediaRef),
              headers: { Authorization: `Bearer ${imageToken ?? ''}` },
            }}
            style={chatStyles.photo}
            accessibilityLabel="Photo from household chat"
            resizeMode="cover"
          />
        ) : null}
        {editing ? (
          <InlineEdit
            label="Edit caption"
            value={draft}
            onChangeText={setDraft}
            placeholder="Add a caption"
            onCancel={() => {
              setDraft(item.caption ?? '');
              setEditing(false);
            }}
            onSave={commitEditCaption}
          />
        ) : item.caption ? (
          <Bubble isOwn={isOwn} edited={Boolean(item.editedAt)}>
            <BubbleText isOwn={isOwn}>{item.caption}</BubbleText>
          </Bubble>
        ) : null}
        {isOwn && withinWindow ? (
          <OwnActions>
            <MiniButton
              label="Edit caption"
              onPress={() => {
                setDraft(item.caption ?? '');
                setEditing(true);
              }}
            />
            <MiniButton
              label="Delete"
              accessibilityLabel="Delete photo"
              onPress={() => {
                void onDelete(item.id);
              }}
            />
          </OwnActions>
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
      <View style={isOwn ? chatStyles.rowOwn : chatStyles.rowTheirs}>
        {!isOwn ? <Text style={chatStyles.sender}>{senderLabel}</Text> : null}
        <View style={[chatStyles.bubble, isOwn ? chatStyles.bubbleOwn : chatStyles.bubbleTheirs]}>
          <View style={chatStyles.voiceRow}>
            <View style={[chatStyles.voiceDisc, isOwn && chatStyles.voiceDiscOwn]}>
              <Text style={chatStyles.voiceGlyph}>🎤</Text>
            </View>
            <View style={chatStyles.voiceMeta}>
              <BubbleText isOwn={isOwn}>Voice note</BubbleText>
              {isPending ? (
                <Text style={isOwn ? chatStyles.metaOwn : chatStyles.meta}>Transcribing…</Text>
              ) : isFailed ? (
                <Text style={isOwn ? chatStyles.metaOwn : chatStyles.meta}>
                  Transcript unavailable
                </Text>
              ) : null}
            </View>
          </View>
          {showTranscript && !correcting && item.transcriptText ? (
            <View style={chatStyles.transcriptBox}>
              <Text style={chatStyles.transcriptText}>{item.transcriptText}</Text>
              {item.transcriptAutomatic ? (
                <Text style={chatStyles.transcriptLabel}>Automatic · may need correction</Text>
              ) : null}
            </View>
          ) : null}
          {correcting ? (
            <InlineEdit
              label="Correct transcript"
              value={transcriptDraft}
              onChangeText={setTranscriptDraft}
              multiline
              onCancel={() => {
                setTranscriptDraft(item.transcriptText ?? '');
                setCorrecting(false);
              }}
              onSave={commitTranscriptCorrection}
            />
          ) : null}
        </View>
        {!correcting && item.transcriptText ? (
          <OwnActions>
            <MiniButton
              label={showTranscript ? 'Hide transcript' : 'View transcript'}
              onPress={() => setShowTranscript((v) => !v)}
            />
            {isOwn && withinWindow ? (
              <MiniButton
                label="Correct"
                accessibilityLabel="Correct transcript"
                onPress={() => {
                  setTranscriptDraft(item.transcriptText ?? '');
                  setCorrecting(true);
                }}
              />
            ) : null}
            {isOwn && withinWindow ? (
              <MiniButton
                label="Delete"
                accessibilityLabel="Delete voice note"
                onPress={() => {
                  void onDelete(item.id);
                }}
              />
            ) : null}
          </OwnActions>
        ) : null}
      </View>
    );
  }

  // ---- Text message ----
  return (
    <View style={isOwn ? chatStyles.rowOwn : chatStyles.rowTheirs}>
      {!isOwn ? <Text style={chatStyles.sender}>{senderLabel}</Text> : null}
      {editing ? (
        <InlineEdit
          label="Edit message"
          value={draft}
          onChangeText={setDraft}
          onCancel={() => {
            setDraft(item.body ?? '');
            setEditing(false);
          }}
          onSave={commitEditText}
        />
      ) : (
        <Bubble isOwn={isOwn} edited={Boolean(item.editedAt)}>
          <BubbleText isOwn={isOwn}>{item.body}</BubbleText>
        </Bubble>
      )}
      {isOwn && withinWindow && !editing ? (
        <OwnActions>
          <MiniButton
            label="Edit"
            accessibilityLabel="Edit message"
            onPress={() => {
              setDraft(item.body ?? '');
              setEditing(true);
            }}
          />
          <MiniButton
            label="Delete"
            accessibilityLabel="Delete message"
            onPress={() => {
              void onDelete(item.id);
            }}
          />
        </OwnActions>
      ) : null}
    </View>
  );
}

function EventRow({ item }: { item: Extract<TimelineItem, { kind: 'event' }> }) {
  const actor = item.actor
    ? `${roleLabel(item.actor.role)} · ${item.actor.displayName}${item.actor.active ? '' : ' · left'}`
    : null;
  return (
    <View style={chatStyles.event}>
      <Text style={chatStyles.eventText}>{item.text}</Text>
      {actor ? <Text style={chatStyles.eventActor}>{actor}</Text> : null}
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
    <View style={chatStyles.outbox}>
      {items.map((row) => (
        <View key={row.localId} style={chatStyles.outboxRow}>
          <Text style={chatStyles.outboxBody} numberOfLines={2}>
            {row.kind === 'photo' ? '📷 ' : row.kind === 'voice' ? '🎤 ' : ''}
            {row.body}
          </Text>
          {row.state === 'sending' ? (
            <Text style={chatStyles.stateSending}>Sending…</Text>
          ) : row.state === 'failed' ? (
            row.failureReason === 'household_access_changed' ? (
              // A removed membership's queued message fails permanently with the
              // specific "Household access changed" label (issue 06, AC#19); it
              // is not retryable.
              <View style={chatStyles.outboxActions}>
                <Text style={chatStyles.stateFailed}>Household access changed</Text>
                <MiniButton
                  label="Dismiss"
                  accessibilityLabel="Dismiss failed message"
                  onPress={() => onCancel(row.localId)}
                />
              </View>
            ) : row.kind === 'text' ? (
              // Only text messages can retry inline; photo and voice require
              // re-upload through the composer (ticket 06, AC#6 — a failed
              // upload cannot create an orphaned visible message).
              <View style={chatStyles.outboxActions}>
                <MiniButton
                  label="Retry"
                  primary
                  accessibilityLabel="Retry sending message"
                  onPress={() => onRetry(row.localId)}
                />
                <MiniButton
                  label="Cancel"
                  accessibilityLabel="Cancel sending message"
                  onPress={() => onCancel(row.localId)}
                />
              </View>
            ) : (
              <View style={chatStyles.outboxActions}>
                <MiniButton
                  label="Dismiss"
                  accessibilityLabel="Dismiss failed upload"
                  onPress={() => onCancel(row.localId)}
                />
              </View>
            )
          ) : (
            <Text style={chatStyles.stateSent}>Sent</Text>
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
  const [pickedPhoto, setPickedPhoto] = useState<{
    data: ArrayBuffer;
    contentType: string;
  } | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isPlayingReview, setIsPlayingReview] = useState(false);
  const [sendingVoice, setSendingVoice] = useState(false);

  const { pickPhoto } = usePhotoPicker();
  const voice = useVoiceRecording(MAX_VOICE_DURATION_MS);
  const reviewPlayerRef = useRef<ReturnType<typeof createReviewPlayer> | null>(null);
  const reviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A slow pulse behind the record button while recording, so the live state is
  // visible without watching the timer.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (voice.phase !== 'recording') {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [voice.phase, pulse]);

  // Clean up the review player and its end-of-playback timer when the component
  // unmounts or the recording is discarded/sent.
  useEffect(() => {
    return () => {
      reviewPlayerRef.current?.remove();
      reviewPlayerRef.current = null;
      if (reviewTimerRef.current) clearTimeout(reviewTimerRef.current);
      reviewTimerRef.current = null;
    };
  }, []);

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

  // ---- Photo: native image picker ----
  async function pickPhotoNative() {
    if (disabled) return;
    setMediaError(null);
    try {
      const result = await pickPhoto();
      if (!result) return; // cancelled or permission denied
      setPickedPhoto({ data: result.data, contentType: result.contentType });
      setShowCaption(true);
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : 'Could not pick photo.');
    }
  }

  function sendPhotoWithCaption() {
    if (!pickedPhoto) return;
    onSendPhoto(pickedPhoto.data, pickedPhoto.contentType, captionDraft.trim() || null);
    setPickedPhoto(null);
    setCaptionDraft('');
    setShowCaption(false);
  }

  function cancelPhoto() {
    setPickedPhoto(null);
    setCaptionDraft('');
    setShowCaption(false);
  }

  // ---- Voice: native recording with review ----
  async function handleRecordPress() {
    if (disabled) return;
    setMediaError(null);
    if (voice.phase === 'idle') {
      const started = await voice.startRecording();
      if (!started && voice.permissionDenied) {
        setMediaError('Microphone permission is needed to record voice notes.');
      }
    } else if (voice.phase === 'recording') {
      await voice.stopRecording();
    }
  }

  function playReview() {
    if (!voice.recordingUri) return;
    // Clean up any prior player and pending end-timer before starting a new one.
    reviewPlayerRef.current?.remove();
    if (reviewTimerRef.current) clearTimeout(reviewTimerRef.current);
    const player = createReviewPlayer(voice.recordingUri);
    reviewPlayerRef.current = player;
    setIsPlayingReview(true);
    player.play();
    // Reset the playing state after a reasonable duration. The expo-audio
    // player does not expose a simple "ended" callback in the current API
    // surface, so we use the known recording duration as an approximation.
    const durationSec = Math.max(1, Math.ceil(voice.durationMs / 1000));
    reviewTimerRef.current = setTimeout(() => {
      setIsPlayingReview(false);
      player.remove();
      reviewPlayerRef.current = null;
      reviewTimerRef.current = null;
    }, durationSec * 1000);
  }

  async function sendVoiceRecording() {
    if (!voice.recordingUri) return;
    setSendingVoice(true);
    setMediaError(null);
    try {
      reviewPlayerRef.current?.remove();
      reviewPlayerRef.current = null;
      if (reviewTimerRef.current) clearTimeout(reviewTimerRef.current);
      reviewTimerRef.current = null;
      setIsPlayingReview(false);
      const data = await readFileAsArrayBuffer(voice.recordingUri);
      onSendVoice(data, VOICE_CONTENT_TYPE, voice.durationMs);
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : 'Could not read voice recording.');
    } finally {
      setSendingVoice(false);
      voice.discardRecording();
    }
  }

  function discardVoiceRecording() {
    reviewPlayerRef.current?.remove();
    reviewPlayerRef.current = null;
    if (reviewTimerRef.current) clearTimeout(reviewTimerRef.current);
    reviewTimerRef.current = null;
    setIsPlayingReview(false);
    voice.discardRecording();
  }

  // ---- Permission denied feedback ----
  const showVoicePermissionError = voice.permissionDenied && voice.phase === 'idle';

  // ---- Review state: show playback + send/discard after recording ----
  if (voice.phase === 'reviewing') {
    return (
      <View style={chatStyles.composer}>
        <View style={chatStyles.reviewBox}>
          <Text style={chatStyles.reviewLabel}>
            Voice note ready ({formatDuration(voice.durationMs)})
          </Text>
          <View style={chatStyles.reviewActions}>
            <MiniButton
              label={isPlayingReview ? '▶ Playing…' : '▶ Play'}
              accessibilityLabel={isPlayingReview ? 'Playing review' : 'Play voice note'}
              disabled={isPlayingReview}
              onPress={playReview}
            />
            <MiniButton
              label="Discard"
              accessibilityLabel="Discard voice note"
              onPress={discardVoiceRecording}
            />
            <MiniButton
              label={sendingVoice ? 'Sending…' : 'Send voice'}
              primary
              accessibilityLabel="Send voice note"
              disabled={sendingVoice}
              onPress={() => void sendVoiceRecording()}
            />
          </View>
        </View>
      </View>
    );
  }

  const canSend = Boolean(draft.trim()) && !disabled;

  return (
    <View style={chatStyles.composer}>
      {mediaError || showVoicePermissionError ? (
        <View style={chatStyles.uploadErrorBox}>
          <Text style={chatStyles.uploadErrorText}>
            {mediaError ?? 'Microphone permission is needed to record voice notes.'}
          </Text>
          <MiniButton
            label="Dismiss"
            accessibilityLabel="Dismiss media error"
            onPress={() => setMediaError(null)}
          />
        </View>
      ) : null}
      {showCaption ? (
        <View style={chatStyles.captionBox}>
          <TextInput
            accessibilityLabel="Photo caption"
            style={chatStyles.input}
            placeholderTextColor={colors.inkSoft}
            placeholder="Add a caption (optional)"
            value={captionDraft}
            onChangeText={setCaptionDraft}
            autoFocus
          />
          <View style={chatStyles.editActions}>
            <MiniButton label="Cancel" accessibilityLabel="Cancel photo" onPress={cancelPhoto} />
            <MiniButton
              label="Send photo"
              primary
              accessibilityLabel="Send photo"
              onPress={sendPhotoWithCaption}
            />
          </View>
        </View>
      ) : (
        <View style={chatStyles.composerRow}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Pick photo from library"
            style={[chatStyles.mediaButton, disabled && chatStyles.sendDisabled]}
            disabled={disabled}
            onPress={() => void pickPhotoNative()}
          >
            <Text style={chatStyles.mediaGlyph}>📷</Text>
          </PressableScale>

          <View>
            {voice.phase === 'recording' ? (
              <Animated.View
                style={[
                  chatStyles.recordPulse,
                  {
                    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                    transform: [
                      { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) },
                    ],
                  },
                ]}
              />
            ) : null}
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={
                voice.phase === 'recording' ? 'Stop recording' : 'Record voice note'
              }
              style={[
                chatStyles.mediaButton,
                voice.phase === 'recording' && chatStyles.recordActive,
              ]}
              disabled={disabled}
              onPress={() => void handleRecordPress()}
            >
              <Text style={chatStyles.mediaGlyph}>{voice.phase === 'recording' ? '⏹' : '🎤'}</Text>
            </PressableScale>
          </View>

          {voice.phase === 'recording' ? (
            <Text style={chatStyles.recordTime}>{formatDuration(voice.durationMs)} / 2:00</Text>
          ) : (
            <TextInput
              accessibilityLabel="Message"
              style={chatStyles.input}
              placeholderTextColor={colors.inkSoft}
              placeholder="Message the household"
              value={draft}
              onChangeText={setDraft}
              editable={!disabled}
              multiline
            />
          )}
          {voice.phase === 'recording' ? null : (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Send message"
              style={[chatStyles.send, !canSend && chatStyles.sendDisabled]}
              disabled={!canSend}
              onPress={submit}
            >
              <Text style={chatStyles.sendGlyph}>↑</Text>
            </PressableScale>
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

const chatStyles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: 58,
    paddingBottom: space.md,
    backgroundColor: colors.surface,
  },
  back: { minHeight: 44, minWidth: 28, alignItems: 'center', justifyContent: 'center' },
  backChevron: { color: colors.accent, fontSize: 30, fontWeight: '700', lineHeight: 34 },
  headerText: { flex: 1 },
  headerName: { fontFamily: fonts.display, fontSize: 18, fontWeight: '700', color: colors.ink },
  headerNote: { fontSize: 12, color: colors.inkSoft, marginTop: 1 },

  cookCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft,
  },
  cookCardText: { flex: 1, gap: 2 },
  cookCardBody: { fontSize: 13, lineHeight: 18, color: colors.ink },

  list: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.lg },
  gap: { height: space.md },
  empty: { alignItems: 'center', paddingTop: space.xl, gap: space.sm },
  emptyTitle: { fontFamily: fonts.display, fontSize: 22, fontWeight: '700', color: colors.ink },

  rowOwn: { alignItems: 'flex-end' },
  rowTheirs: { alignItems: 'flex-start' },
  sender: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkSoft,
    marginBottom: 4,
    marginLeft: 4,
  },

  // One squared corner on the sender's side gives each bubble a tail without
  // drawing one.
  bubble: { maxWidth: '82%', borderRadius: radius.lg, paddingVertical: 11, paddingHorizontal: 15 },
  bubbleOwn: { backgroundColor: colors.accent, borderBottomRightRadius: 6, ...shadow.soft },
  bubbleOwnText: { color: '#FFFFFF', fontSize: 16, lineHeight: 22 },
  bubbleTheirs: {
    backgroundColor: colors.card,
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bubbleTheirsText: { color: colors.ink, fontSize: 16, lineHeight: 22 },
  meta: { color: colors.inkSoft, fontSize: 11, marginTop: 3 },
  metaOwn: { color: 'rgba(255,255,255,0.82)', fontSize: 11, marginTop: 3 },
  tombstone: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  tombstoneText: { color: colors.inkSoft, fontStyle: 'italic', fontSize: 14 },

  ownActions: { flexDirection: 'row', gap: space.xs, marginTop: space.xs },
  editBox: { maxWidth: '86%', gap: space.sm },
  editActions: { flexDirection: 'row', gap: space.sm },

  event: {
    alignSelf: 'center',
    maxWidth: '90%',
    backgroundColor: colors.surfaceDeep,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    gap: 1,
  },
  eventText: { color: colors.inkSoft, fontSize: 13, textAlign: 'center' },
  eventActor: { color: colors.inkSoft, fontSize: 11, opacity: 0.8 },

  outbox: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  outboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingVertical: space.xs,
  },
  outboxBody: { flex: 1, color: colors.inkSoft, fontSize: 14, fontStyle: 'italic' },
  outboxActions: { flexDirection: 'row', gap: space.xs, alignItems: 'center' },
  stateSending: { color: colors.inkSoft, fontSize: 12 },
  stateSent: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  stateFailed: { color: colors.danger, fontSize: 12, fontWeight: '700' },

  uploadErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    marginBottom: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: '#FBEAE6',
  },
  uploadErrorText: { flex: 1, color: colors.danger, fontSize: 14, lineHeight: 19 },

  composer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  captionBox: { gap: space.sm },
  reviewBox: { gap: space.sm, paddingVertical: space.xs },
  reviewLabel: { fontSize: 15, fontWeight: '700', color: colors.ink },
  reviewActions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },

  mediaButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surfaceDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaGlyph: { fontSize: 20 },
  recordActive: { backgroundColor: colors.danger },
  recordPulse: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.danger,
  },
  recordTime: {
    flex: 1,
    fontSize: 19,
    fontWeight: '700',
    color: colors.danger,
    textAlign: 'center',
  },

  photo: { width: 248, height: 186, borderRadius: radius.lg, backgroundColor: colors.field },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  voiceDisc: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surfaceDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceDiscOwn: { backgroundColor: 'rgba(255,255,255,0.22)' },
  voiceGlyph: { fontSize: 17 },
  voiceMeta: { gap: 1 },
  transcriptBox: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  transcriptText: { fontSize: 14, lineHeight: 20, color: colors.ink },
  transcriptLabel: {
    fontSize: 11,
    color: colors.inkSoft,
    marginTop: space.xs,
    fontStyle: 'italic',
  },

  input: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: colors.surface,
    color: colors.ink,
    minHeight: 46,
    maxHeight: 120,
  },
  send: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.soft,
  },
  sendGlyph: { color: '#FFFFFF', fontWeight: '700', fontSize: 22, lineHeight: 25 },
  sendDisabled: { opacity: 0.45 },
  hint: { color: colors.inkSoft, fontSize: 15, textAlign: 'center', lineHeight: 21 },
});
