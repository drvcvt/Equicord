/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { HeaderBarButton } from "@api/HeaderBar";
import { showNotification } from "@api/Notifications";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { User } from "@vencord/discord-types";
import { ChannelStore, GuildStore, Menu, UserStore, VoiceStateStore } from "@webpack/common";

import { openStalkerModal } from "./components/StalkerModal";
import settings from "./settings";
import {
    addTracked,
    getEntries,
    getTracked,
    initStore,
    isTracked,
    logEntry,
    persistAttachment,
    removeTracked,
    setLiveSession,
    setOnTrackAddedHook,
    setTyping
} from "./store";
import {
    ActivityEntry,
    MessageEntry,
    PresenceEntry,
    ProfileChangeEntry,
    ProfileField,
    SoundboardEntry,
    VoiceFlagEntry,
    VoiceJoinEntry,
    VoiceLeaveEntry,
    VoiceMoveEntry
} from "./types";

const logger = new Logger("UserStalker", "#ff69b4");

interface VoiceStateEntry {
    guildId?: string;
    channelId?: string;
    oldChannelId?: string;
    userId: string;
    mute: boolean;
    deaf: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
    selfVideo: boolean;
    selfStream?: boolean;
}

interface TrackedVoiceState {
    channelId: string | null;
    joinedAt: number | null;
    mute: boolean;
    deaf: boolean;
    selfVideo: boolean;
    selfStream: boolean;
}

const voiceStateCache = new Map<string, TrackedVoiceState>();
const lastPresenceStatus = new Map<string, string>();
const loggedActivities = new Set<string>();
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let pluginBootTs = 0;
const PRESENCE_BOOT_QUIET_MS = 5_000;

interface ProfileSnapshot {
    username?: string;
    globalName?: string;
    avatar?: string;
    customStatus?: string;
}
const lastProfile = new Map<string, ProfileSnapshot>();

async function emitProfileChange(userId: string, field: ProfileField, oldValue?: string | null, newValue?: string | null) {
    const entry: ProfileChangeEntry = {
        type: "profile_change",
        userId,
        timestamp: Date.now(),
        field,
        oldValue: oldValue ?? null,
        newValue: newValue ?? null
    };
    await logEntry(entry);
}

async function checkProfileDiff(userId: string, snap: Partial<ProfileSnapshot>) {
    if (!isTracked(userId)) return;
    const prev = lastProfile.get(userId) ?? {};
    const next: ProfileSnapshot = { ...prev };
    const isBoot = Date.now() - pluginBootTs < PRESENCE_BOOT_QUIET_MS;

    for (const f of ["username", "globalName", "avatar", "customStatus"] as ProfileField[]) {
        if (snap[f] === undefined) continue; // not provided in this update
        next[f] = snap[f] as any;
        const oldV = prev[f];
        const newV = snap[f];
        if (oldV === undefined) continue; // first-seen, don't log
        if (oldV === newV) continue;
        if (isBoot) continue; // suppress boot-time discoveries
        await emitProfileChange(userId, f, oldV ?? null, newV ?? null);
    }
    lastProfile.set(userId, next);
}

function profileFromUserObj(u: any): Partial<ProfileSnapshot> {
    return {
        username: u?.username,
        globalName: u?.globalName ?? u?.global_name ?? undefined,
        avatar: u?.avatar ?? undefined
    };
}

function findUserVoiceState(userId: string): { channelId: string; guildId?: string; mute?: boolean; deaf?: boolean; selfVideo?: boolean; selfStream?: boolean; } | null {
    try {
        const all = VoiceStateStore.getAllVoiceStates?.() ?? {};
        for (const guildId of Object.keys(all)) {
            const guildStates = all[guildId] as Record<string, any>;
            const s = guildStates?.[userId];
            if (s?.channelId) {
                return {
                    channelId: s.channelId,
                    guildId: guildId || undefined,
                    mute: !!s.mute,
                    deaf: !!s.deaf,
                    selfVideo: !!s.selfVideo,
                    selfStream: !!s.selfStream
                };
            }
        }
    } catch { /* store not ready */ }
    return null;
}

/**
 * Reconcile our voiceStateCache/liveSession with Discord's local VoiceStateStore.
 * Purely client-side, no network calls — safe to run periodically.
 */
function reconcileVoiceStateFor(userId: string) {
    const vs = findUserVoiceState(userId);
    const prev = voiceStateCache.get(userId);
    const now = Date.now();

    if (vs) {
        const changedChannel = prev?.channelId !== vs.channelId;
        const joinedAt = prev && !changedChannel ? prev.joinedAt ?? now : now;
        voiceStateCache.set(userId, {
            channelId: vs.channelId,
            joinedAt,
            mute: vs.mute ?? false,
            deaf: vs.deaf ?? false,
            selfVideo: vs.selfVideo ?? false,
            selfStream: vs.selfStream ?? false
        });
        setLiveSession(userId, { channelId: vs.channelId, guildId: vs.guildId ?? null, joinedAt });
    } else if (prev?.channelId) {
        // user left without us noticing — clear cache + live session, don't log synthetic leave
        voiceStateCache.set(userId, { ...prev, channelId: null, joinedAt: null });
        setLiveSession(userId, null);
    } else if (prev === undefined) {
        // not in VC and we had no prior state — still seed an empty cache so future events have context
        voiceStateCache.set(userId, { channelId: null, joinedAt: null, mute: false, deaf: false, selfVideo: false, selfStream: false });
    }
}

function reconcileAllTracked() {
    for (const userId of Object.keys(getTracked())) {
        reconcileVoiceStateFor(userId);
        // cheap username/avatar/globalName diff via UserStore (no API call)
        const u = UserStore.getUser(userId);
        if (u) checkProfileDiff(userId, profileFromUserObj(u));
    }
}

function channelLabel(channelId?: string | null): string {
    if (!channelId) return "?";
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return channelId;
    return ch.name || `#${channelId}`;
}

function guildLabel(guildId?: string | null): string {
    if (!guildId) return "DM";
    const g = GuildStore.getGuild(guildId);
    return g?.name ?? guildId;
}

function notifyMessage(msg: MessageEntry, user?: User) {
    if (!settings.store.notifyOnMessage) return;
    const tracked = getTracked()[msg.userId];
    if (tracked && tracked.notify === false) return;
    showNotification({
        title: `${user?.username ?? msg.userId} in #${channelLabel(msg.channelId)}`,
        body: msg.content?.slice(0, 200) ?? "[no text]",
        onClick: () => openStalkerModal(msg.userId)
    });
}

function notifyVoice(e: VoiceJoinEntry, user?: User) {
    if (!settings.store.notifyOnVoiceJoin) return;
    const tracked = getTracked()[e.userId];
    if (tracked && tracked.notify === false) return;
    showNotification({
        title: `${user?.username ?? e.userId} joined voice`,
        body: `${guildLabel(e.guildId)} / ${channelLabel(e.channelId)}`,
        onClick: () => openStalkerModal(e.userId)
    });
}

function notifyOnline(userId: string, user?: User) {
    if (!settings.store.notifyOnOnline) return;
    const tracked = getTracked()[userId];
    if (tracked && tracked.notify === false) return;
    showNotification({
        title: `${user?.username ?? userId} is online`,
        body: "Came online just now",
        onClick: () => openStalkerModal(userId)
    });
}

async function handleMessage(payload: any, type: "message" | "message_edit" | "message_delete") {
    const msg = payload.message ?? {};
    const authorId = msg.author?.id ?? payload.authorId;
    if (!authorId || !isTracked(authorId)) return;

    if (type === "message_delete") {
        if (!settings.store.logMessageDeletes) return;
        const entry: MessageEntry = {
            type: "message_delete",
            userId: authorId,
            timestamp: Date.now(),
            guildId: payload.guildId ?? null,
            channelId: payload.channelId ?? null,
            messageId: payload.id ?? msg.id
        };
        await logEntry(entry);
        return;
    }

    if (type === "message_edit" && !settings.store.logMessageEdits) return;
    if (type === "message" && !settings.store.logMessages) return;

    const channelId: string | undefined = msg.channel_id ?? payload.channelId;
    const ch = channelId ? ChannelStore.getChannel(channelId) : null;
    const isDM = ch && (ch.type === 1 || ch.type === 3);
    if (isDM && !settings.store.logDMs) return;

    const attachments = Array.isArray(msg.attachments) && msg.attachments.length
        ? msg.attachments.map((a: any) => ({
            url: a.url,
            proxyUrl: a.proxy_url ?? a.proxyURL,
            filename: a.filename ?? a.name ?? "file",
            contentType: a.content_type ?? a.contentType,
            width: a.width,
            height: a.height,
            size: a.size
        }))
        : undefined;

    const refMsg = msg.referenced_message ?? msg.messageReference;
    const replyTo = refMsg && refMsg.id
        ? {
            messageId: refMsg.id,
            authorId: refMsg.author?.id,
            authorName: refMsg.author?.global_name ?? refMsg.author?.globalName ?? refMsg.author?.username,
            content: refMsg.content?.slice(0, 200)
        }
        : (msg.message_reference?.message_id ? { messageId: msg.message_reference.message_id } : undefined);

    const entry: MessageEntry = {
        type,
        userId: authorId,
        timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
        guildId: payload.guildId ?? ch?.guild_id ?? null,
        channelId: channelId ?? null,
        messageId: msg.id,
        content: msg.content ?? undefined,
        attachments,
        stickers: msg.sticker_items?.length ?? msg.stickers?.length ?? 0,
        mentions: msg.mentions?.map((m: any) => m.id ?? m) ?? undefined,
        replyTo
    };

    await logEntry(entry);

    // Persist attachments in background (CDN URLs expire ~24h, we want archival copies).
    // Mutates entry.attachments in place with localPath — new messages will get the path,
    // already-logged-to-disk lines keep the old URL but the in-memory entry now has localPath
    // so UI reads it right away. The next session re-reads from disk which won't have it,
    // but that's fine for this MVP (attachment is still on T:\ under its messageId).
    if (type === "message" && attachments && attachments.length > 0 && msg.id) {
        attachments.forEach((att, i) => {
            persistAttachment(authorId, msg.id, i, att.url, att.filename).then(p => {
                if (p) att.localPath = p;
            }).catch(() => { /* swallow */ });
        });
    }

    if (type === "message") notifyMessage(entry, msg.author as User | undefined);
}

function getCoVcUsers(channelId: string, excludeUserId: string): string[] {
    try {
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
        return Object.keys(states).filter(id => id !== excludeUserId);
    } catch {
        return [];
    }
}

async function handleVoiceStateUpdate(s: VoiceStateEntry) {
    if (!settings.store.logVoice) return;
    if (!isTracked(s.userId)) return;

    const prev = voiceStateCache.get(s.userId);
    const now = Date.now();
    const newChannelId = s.channelId ?? null;
    const oldChannelId = prev?.channelId ?? s.oldChannelId ?? null;

    if (newChannelId !== oldChannelId) {
        if (oldChannelId && !newChannelId) {
            // leave
            const durationMs = prev?.joinedAt ? now - prev.joinedAt : undefined;
            const entry: VoiceLeaveEntry = {
                type: "voice_leave",
                userId: s.userId,
                timestamp: now,
                guildId: s.guildId ?? null,
                channelId: oldChannelId,
                durationMs
            };
            await logEntry(entry);
            setLiveSession(s.userId, null);
        } else if (!oldChannelId && newChannelId) {
            // join
            const entry: VoiceJoinEntry = {
                type: "voice_join",
                userId: s.userId,
                timestamp: now,
                guildId: s.guildId ?? null,
                channelId: newChannelId,
                otherUserIds: getCoVcUsers(newChannelId, s.userId)
            };
            await logEntry(entry);
            setLiveSession(s.userId, { channelId: newChannelId, guildId: s.guildId ?? null, joinedAt: now });
            notifyVoice(entry, UserStore.getUser(s.userId));
        } else if (oldChannelId && newChannelId) {
            // move
            const entry: VoiceMoveEntry = {
                type: "voice_move",
                userId: s.userId,
                timestamp: now,
                guildId: s.guildId ?? null,
                channelId: newChannelId,
                oldChannelId,
                newChannelId
            };
            await logEntry(entry);
            setLiveSession(s.userId, { channelId: newChannelId, guildId: s.guildId ?? null, joinedAt: prev?.joinedAt ?? now });
        }
    }

    if (prev && newChannelId) {
        const flags: Array<[VoiceFlagEntry["type"], boolean]> = [];
        if (prev.mute !== s.mute) flags.push(["voice_mute", s.mute]);
        if (prev.deaf !== s.deaf) flags.push(["voice_deaf", s.deaf]);
        if (prev.selfVideo !== s.selfVideo) flags.push(["voice_video", s.selfVideo]);
        const newStream = s.selfStream ?? false;
        if (prev.selfStream !== newStream) flags.push(["voice_stream", newStream]);
        for (const [type, enabled] of flags) {
            const entry: VoiceFlagEntry = {
                type,
                userId: s.userId,
                timestamp: now,
                guildId: s.guildId ?? null,
                channelId: newChannelId,
                enabled
            };
            await logEntry(entry);
        }
    }

    voiceStateCache.set(s.userId, {
        channelId: newChannelId,
        joinedAt: newChannelId
            ? (newChannelId === oldChannelId ? prev?.joinedAt ?? now : now)
            : null,
        mute: s.mute,
        deaf: s.deaf,
        selfVideo: s.selfVideo,
        selfStream: s.selfStream ?? false
    });
}

function StalkerIcon({ height = 24, width = 24 }: { height?: number; width?: number; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="9" r="3" stroke="currentColor" strokeWidth="2" />
            <path d="M4 20c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="18" cy="6" r="2" fill="currentColor" />
        </svg>
    );
}

function StalkerHeaderButton() {
    return (
        <HeaderBarButton
            onClick={() => openStalkerModal()}
            tooltip="User Stalker"
            icon={StalkerIcon}
        />
    );
}

const UserContextMenuPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;
    const tracked = isTracked(user.id);
    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="user-stalker-toggle"
                label={tracked ? "Untrack User (Stalker)" : "Track User (Stalker)"}
                action={async () => {
                    if (tracked) {
                        await removeTracked(user.id);
                        voiceStateCache.delete(user.id);
                        setLiveSession(user.id, null);
                    } else {
                        await addTracked({ id: user.id, username: user.username, addedAt: Date.now(), notify: true });
                        reconcileVoiceStateFor(user.id);
                    }
                }}
            />
            {tracked && (
                <Menu.MenuItem
                    id="user-stalker-view"
                    label="View Stalker Log"
                    action={() => openStalkerModal(user.id)}
                />
            )}
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "UserStalker",
    description: "Tracks selected users across mutual servers: messages, voice activity, presence. Stored to disk.",
    authors: [EquicordDevs.Matti],
    settings,

    contextMenus: {
        "user-context": UserContextMenuPatch
    },

    headerBarButton: {
        icon: StalkerIcon,
        render: StalkerHeaderButton
    },

    commands: [
        {
            name: "stalker",
            description: "Open the User Stalker dashboard.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_, ctx) => {
                openStalkerModal();
                sendBotMessage(ctx.channel.id, { content: "Opened Stalker." });
            }
        }
    ],

    toolboxActions: {
        "Open Stalker"() {
            openStalkerModal();
        }
    },

    async start() {
        pluginBootTs = Date.now();
        setOnTrackAddedHook(userId => reconcileVoiceStateFor(userId));
        await initStore(settings.store.dataDir);
        reconcileAllTracked();
        // Periodic reconciliation against Discord's local VoiceStateStore.
        // Catches users added while in VC and any drift from missed flux events.
        // All reads are client-local — no API calls, no rate limit.
        reconcileTimer = setInterval(reconcileAllTracked, 30_000);
    },

    stop() {
        if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
        voiceStateCache.clear();
        lastPresenceStatus.clear();
        loggedActivities.clear();
        lastProfile.clear();
    },

    flux: {
        async MESSAGE_CREATE(payload: any) {
            if (payload.optimistic) return;
            await handleMessage(payload, "message");
        },

        async MESSAGE_UPDATE(payload: any) {
            // Discord fires MESSAGE_UPDATE for embed/reaction refreshes too.
            // Only log real content edits.
            if (payload.message?.content == null) return;
            await handleMessage(payload, "message_edit");
        },

        async MESSAGE_DELETE(payload: any) {
            if (!settings.store.logMessageDeletes) return;
            const messageId: string | undefined = payload.id ?? payload.message?.id;
            if (!messageId) return;
            // Discord's MESSAGE_DELETE payload usually omits the author.
            // Cross-reference our own logs to find whose tracked message was deleted.
            let authorId = payload.message?.author?.id as string | undefined;
            if (!authorId) {
                for (const uid of Object.keys(getTracked())) {
                    const entries = getEntries(uid);
                    // scan from newest — deletions tend to hit recent messages
                    for (let i = entries.length - 1; i >= 0; i--) {
                        const e = entries[i];
                        if ((e.type === "message" || e.type === "message_edit") && e.messageId === messageId) {
                            authorId = uid;
                            break;
                        }
                    }
                    if (authorId) break;
                }
            }
            if (!authorId) return;
            await handleMessage({ ...payload, authorId }, "message_delete");
        },

        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateEntry[]; }) {
            for (const s of voiceStates) {
                if (!isTracked(s.userId)) continue;
                handleVoiceStateUpdate(s).catch(e => logger.error("voice handler", e));
            }
        },

        TYPING_START({ userId, channelId }: { userId: string; channelId: string; }) {
            if (!isTracked(userId)) return;
            setTyping(userId, channelId);
        },

        USER_UPDATE({ user }: { user: any; }) {
            if (!user?.id || !isTracked(user.id)) return;
            checkProfileDiff(user.id, profileFromUserObj(user));
        },

        async VOICE_CHANNEL_EFFECT_SEND(event: { userId: string; channelId: string; soundId?: string; emoji?: { name: string; }; }) {
            if (!settings.store.logSoundboard) return;
            if (!event?.userId || !isTracked(event.userId)) return;
            const entry: SoundboardEntry = {
                type: "voice_soundboard",
                userId: event.userId,
                timestamp: Date.now(),
                channelId: event.channelId,
                guildId: ChannelStore.getChannel(event.channelId)?.guild_id ?? null,
                soundId: event.soundId,
                emojiName: event.emoji?.name
            };
            await logEntry(entry);
        },

        async EMBEDDED_ACTIVITY_UPDATE_V2(event: any) {
            if (!settings.store.logActivity) return;
            const channelId = event?.location?.channel_id;
            const appId = event?.applicationId;
            if (!channelId || !appId) return;
            const participants: string[] = (event.participants ?? []).map((p: any) => p.user_id);

            for (const uid of participants) {
                if (!isTracked(uid)) continue;
                const key = `${uid}-${appId}`;
                if (loggedActivities.has(key)) continue;
                loggedActivities.add(key);
                const entry: ActivityEntry = {
                    type: "activity_start",
                    userId: uid,
                    timestamp: Date.now(),
                    channelId,
                    guildId: ChannelStore.getChannel(channelId)?.guild_id ?? null,
                    activityName: event.name ?? "Activity",
                    applicationId: appId
                };
                await logEntry(entry);
            }

            const currentSet = new Set(participants);
            for (const key of [...loggedActivities]) {
                if (!key.endsWith(`-${appId}`)) continue;
                const uid = key.slice(0, -(appId.length + 1));
                if (!currentSet.has(uid)) {
                    loggedActivities.delete(key);
                    if (!isTracked(uid)) continue;
                    const entry: ActivityEntry = {
                        type: "activity_stop",
                        userId: uid,
                        timestamp: Date.now(),
                        channelId,
                        guildId: ChannelStore.getChannel(channelId)?.guild_id ?? null,
                        activityName: event.name ?? "Activity",
                        applicationId: appId
                    };
                    await logEntry(entry);
                }
            }
        },

        async PRESENCE_UPDATES({ updates }: { updates: Array<{ user: { id: string; }; status: string; activities?: any[]; }>; }) {
            const quiet = Date.now() - pluginBootTs < PRESENCE_BOOT_QUIET_MS;
            for (const u of updates) {
                const uid = u.user?.id;
                if (!uid || !isTracked(uid)) continue;
                // custom status is activity type 4
                const customAct = (u.activities ?? []).find((a: any) => a.type === 4);
                const customText = customAct ? [customAct.emoji?.name, customAct.state].filter(Boolean).join(" ") : "";
                checkProfileDiff(uid, { customStatus: customText });

                const prev = lastPresenceStatus.get(uid);
                const cur = u.status as PresenceEntry["status"];
                if (prev === cur) continue;
                lastPresenceStatus.set(uid, cur);
                // During boot window, seed the presence map silently — don't log the
                // dump Discord sends right after connect.
                if (quiet) continue;
                if (!settings.store.logPresence) continue;
                const entry: PresenceEntry = {
                    type: "presence",
                    userId: uid,
                    timestamp: Date.now(),
                    status: cur
                };
                await logEntry(entry);
                if (prev && prev !== "online" && cur === "online") {
                    notifyOnline(uid, UserStore.getUser(uid));
                }
            }
        }
    }
});
