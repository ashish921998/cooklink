import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAccessProbe, type HouseholdSummary } from '../lib/households';
import { EDIT_WINDOW_MS, type OutboxItem, type TimelineItem, useHouseholdChat } from '../lib/chat';
import { Loading, Message, colors } from '../components/ui';

/**
 * Household Chat (issue 04 — text chat).
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

  // Mark-read is best-effort when the newest item is visible. We track the
  // latest id seen at the bottom of the list and post it once per arrival.
  const markedRef = useRef<string | null>(null);

  const chat = useHouseholdChat(household.id, membershipId);

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
      />
      <Outbox items={chat.outbox} onRetry={chat.retry} onCancel={chat.cancel} />
      <Composer
        disabled={!membershipId}
        onSend={(body) => {
          void chat.send(body);
        }}
        onMountedAtBottom={(id) => {
          // Mark read through the newest human message when Chat is open and the
          // latest position is visible. System events never move the read cursor
          // (issue 06 — routine events do not add unread debt). Best-effort.
          if (id && membershipId && markedRef.current !== id) {
            markedRef.current = id;
            void chat.markRead(id);
          }
        }}
        // The last human message drives the read position, not the last event.
        newestItemId={chat.items.findLast((t) => t.kind === 'message')?.id}
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
}: {
  item: TimelineItem;
  ownMembershipId: string | null;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  if (item.kind === 'event') return <EventRow item={item} />;
  return (
    <MessageRow
      item={item}
      isOwn={Boolean(ownMembershipId) && item.senderId === ownMembershipId}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

function MessageRow({
  item,
  isOwn,
  onEdit,
  onDelete,
}: {
  item: Extract<TimelineItem, { kind: 'message' }>;
  isOwn: boolean;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.body ?? '');

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

  async function commitEdit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    await onEdit(item.id, trimmed);
    setEditing(false);
  }

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
              onPress={commitEdit}
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
            ) : (
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
  onMountedAtBottom,
  newestItemId,
}: {
  disabled: boolean;
  onSend: (body: string) => void;
  onMountedAtBottom: (id: string | undefined) => void;
  newestItemId: string | undefined;
}) {
  const [draft, setDraft] = useState('');

  // When the newest server item changes and the composer is mounted (i.e. Chat
  // is open and the latest position is visible), report it for mark-read.
  useEffect(() => {
    onMountedAtBottom(newestItemId);
  }, [newestItemId, onMountedAtBottom]);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft('');
  }

  return (
    <View style={styles.composer}>
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send message"
        style={[styles.send, (!draft.trim() || disabled) && styles.sendDisabled]}
        disabled={!draft.trim() || disabled}
        onPress={submit}
      >
        <Text style={styles.sendText}>Send</Text>
      </Pressable>
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
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 20,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
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
