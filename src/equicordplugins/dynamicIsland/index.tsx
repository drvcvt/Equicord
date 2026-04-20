/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { requireStyle } from "@api/Styles";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import {
    ChannelStore,
    createRoot,
    GuildStore,
    NavigationRouter,
    SelectedChannelStore,
    UserStore
} from "@webpack/common";
import type { Root } from "react-dom/client";

import { isTracked } from "../userStalker/store";
import islandStyleName from "./components/Island.css?managed";
import { Island } from "./components/Island";
import { onSelfVoiceStateUpdate, startLiveActivities, stopLiveActivities } from "./liveActivities";
import settings from "./settings";
import { dismiss, dismissByType, getById, onPushEvent, push } from "./store";
import { Priority } from "./types";

const GROUP_WINDOW_MS = 10_000;

const logger = new Logger("DynamicIsland", "#a78bfa");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const lastPresence = new Map<string, string>();
const lastActivities = new Map<string, string>();
const lastVoiceChannel = new Map<string, string | null>();
const streamingNow = new Set<string>();

let bootTs = 0;
const BOOT_QUIET_MS = 5_000;

function isBoot() { return Date.now() - bootTs < BOOT_QUIET_MS; }

function defaultDuration(): number {
    return settings.store.defaultDuration * 1000;
}

function avatarURL(user: any): string | undefined {
    try { return user?.getAvatarURL?.(undefined, 64, false); } catch { return undefined; }
}

function userLabel(user: any, fallbackId?: string): string {
    return user?.globalName || user?.global_name || user?.username || fallbackId || "Unknown";
}

function channelLabel(channelId?: string | null): string {
    if (!channelId) return "?";
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return "?";
    if (ch.name) return `#${ch.name}`;
    if (ch.type === 1) return "DM";
    if (ch.type === 3) return ch.name || "Group DM";
    return channelId;
}

function guildLabel(guildId?: string | null): string {
    if (!guildId) return "DM";
    return GuildStore.getGuild(guildId)?.name ?? "Server";
}

/**
 * Where-context subtitle. Returns undefined for 1:1 DMs (the badge already says "DM"
 * so adding more would just repeat). Group DM → group name. Server → "#channel · Server".
 */
function contextSubtitle(channelId?: string | null, guildId?: string | null): string | undefined {
    if (!channelId) return undefined;
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return undefined;
    if (!guildId) {
        // DM context
        if (ch.type === 1) return undefined; // 1:1 — badge is enough
        if (ch.type === 3) return ch.name || "Group DM";
        return undefined;
    }
    return `${channelLabel(channelId)} · ${guildLabel(guildId)}`;
}

function jumpTo(guildId: string | null | undefined, channelId: string, messageId?: string) {
    const path = `/channels/${guildId ?? "@me"}/${channelId}${messageId ? `/${messageId}` : ""}`;
    NavigationRouter.transitionTo(path);
}

function selfId(): string | undefined {
    try { return UserStore.getCurrentUser()?.id; } catch { return undefined; }
}

function suppressedByFocus(channelId?: string | null): boolean {
    if (!settings.store.suppressWhenFocused) return false;
    if (!channelId) return false;
    if (!document.hasFocus()) return false;
    try { return SelectedChannelStore.getChannelId() === channelId; } catch { return false; }
}

// === Source: tracked user sends a message ===
function handleMessageCreate(payload: any) {
    if (payload.optimistic) return;
    if (isBoot()) return;
    if (!settings.store.notifyMessages) return;
    const msg = payload.message ?? {};
    const channelId: string | undefined = msg.channel_id ?? payload.channelId;
    const authorId: string | undefined = msg.author?.id;
    const me = selfId();
    if (!channelId || !authorId || !me || authorId === me) return;
    if (!isTracked(authorId)) return;
    if (suppressedByFocus(channelId)) return;

    const ch = ChannelStore.getChannel(channelId);
    const author = UserStore.getUser(authorId) ?? msg.author;
    const BODY_LIMIT = 180;
    const raw = (msg.content ?? "").trim();
    const truncated = raw.length > BODY_LIMIT ? raw.slice(0, BODY_LIMIT - 1).trimEnd() + "…" : raw;
    const content: string = truncated || (msg.attachments?.length ? "[attachment]" : "[no text]");

    const mentionsMe = (msg.mentions ?? []).some((m: any) => (typeof m === "string" ? m : m?.id) === me)
        || msg.mention_everyone === true
        || (msg.referenced_message?.author?.id === me);
    const isDM = ch && (ch.type === 1 || ch.type === 3);

    // Group consecutive messages from the same user in the same channel within
    // GROUP_WINDOW_MS into a single event — prevents spam-flooding the island.
    const groupId = `msg-${authorId}-${channelId}`;
    const existing = getById(groupId);
    const now = Date.now();
    const isGrouping = !!(existing && existing.userId === authorId && (now - existing.createdAt) < GROUP_WINDOW_MS);
    const count = isGrouping ? (existing!.count ?? 1) + 1 : 1;
    const baseLabel = userLabel(author, authorId);
    const title = count > 1 ? `${baseLabel}  +${count - 1}` : baseLabel;

    push({
        id: groupId,
        type: mentionsMe ? "mention" : isDM ? "dm" : "stalker",
        priority: mentionsMe ? Priority.High : isDM ? Priority.High : Priority.Medium,
        title,
        subtitle: contextSubtitle(channelId, ch?.guild_id),
        avatarUrl: avatarURL(author),
        accent: mentionsMe ? "#f0b232" : isDM ? "#5865f2" : "#ff69b4",
        duration: mentionsMe ? defaultDuration() * 2 : defaultDuration(),
        body: content,
        onClick: () => jumpTo(ch?.guild_id, channelId, msg.id),
        replyTarget: msg.id ? { channelId, messageId: msg.id } : undefined,
        userId: authorId,
        channelId,
        guildId: ch?.guild_id ?? undefined,
        count
    });
}

// === Source: tracked user voice activity ===
function handleVoiceStates(voiceStates: any[]) {
    const me = selfId();

    // Live activity: dispatch self state changes regardless of tracking settings
    for (const s of voiceStates) {
        if (s.userId === me) {
            try { onSelfVoiceStateUpdate(!!s.selfStream); } catch (e) { logger.error("live voice update", e); }
            break;
        }
    }

    if (!settings.store.notifyVoice && !settings.store.notifyStream) return;

    // My current voice channel — used to opportunistically surface events for
    // everyone else who's in the same VC, not just tracked users.
    let myVcId: string | null = null;
    try { myVcId = SelectedChannelStore.getVoiceChannelId?.() ?? null; } catch { /* */ }

    for (const s of voiceStates) {
        const uid: string = s.userId;
        if (!uid || uid === me) continue;

        const newCh: string | null = s.channelId ?? null;
        const prevCh = lastVoiceChannel.get(uid) ?? null;

        // Show this state change if user is tracked OR (notifyVcMembers AND they're
        // in my voice channel now or were just before this update).
        const inMyVc = !!myVcId && (newCh === myVcId || prevCh === myVcId);
        if (!isTracked(uid) && !(settings.store.notifyVcMembers && inMyVc)) continue;

        if (newCh !== prevCh) {
            lastVoiceChannel.set(uid, newCh);
            if (!isBoot() && settings.store.notifyVoice) {
                const u = UserStore.getUser(uid);
                if (newCh && !prevCh) {
                    push({
                        type: "voice_join",
                        priority: Priority.Medium,
                        title: userLabel(u, uid),
                        subtitle: contextSubtitle(newCh, s.guildId),
                        avatarUrl: avatarURL(u),
                        accent: "#23a55a",
                        duration: defaultDuration(),
                        onClick: () => jumpTo(s.guildId ?? null, newCh),
                        userId: uid,
                        channelId: newCh,
                        guildId: s.guildId ?? undefined
                    });
                } else if (prevCh && !newCh) {
                    push({
                        type: "voice_leave",
                        priority: Priority.Low,
                        title: userLabel(u, uid),
                        subtitle: contextSubtitle(prevCh, s.guildId),
                        avatarUrl: avatarURL(u),
                        accent: "#80848e",
                        duration: defaultDuration(),
                        userId: uid,
                        channelId: prevCh,
                        guildId: s.guildId ?? undefined
                    });
                } else if (prevCh && newCh) {
                    push({
                        type: "voice_move",
                        priority: Priority.Low,
                        title: userLabel(u, uid),
                        subtitle: `→ ${channelLabel(newCh)}`,
                        avatarUrl: avatarURL(u),
                        accent: "#80848e",
                        duration: defaultDuration(),
                        onClick: () => jumpTo(s.guildId ?? null, newCh),
                        userId: uid,
                        channelId: newCh,
                        guildId: s.guildId ?? undefined
                    });
                }
            }
        }

        if (settings.store.notifyStream) {
            const streaming = !!s.selfStream;
            const wasStreaming = streamingNow.has(uid);
            if (streaming && !wasStreaming) {
                streamingNow.add(uid);
                if (!isBoot()) {
                    const u = UserStore.getUser(uid);
                    push({
                        type: "stream_start",
                        priority: Priority.High,
                        title: userLabel(u, uid),
                        subtitle: contextSubtitle(newCh ?? prevCh, s.guildId),
                        avatarUrl: avatarURL(u),
                        accent: "#593695",
                        duration: defaultDuration() * 2,
                        onClick: () => newCh && jumpTo(s.guildId ?? null, newCh),
                        userId: uid,
                        channelId: newCh ?? prevCh ?? undefined,
                        guildId: s.guildId ?? undefined
                    });
                }
            } else if (!streaming && wasStreaming) {
                streamingNow.delete(uid);
            }
        }
    }
}

// === Source: tracked user presence ===
function handlePresenceUpdates(updates: any[]) {
    const me = selfId();
    for (const u of updates) {
        const uid: string = u.user?.id;
        if (!uid || uid === me) continue;
        if (!isTracked(uid)) continue;

        const status: string = u.status;
        const prev = lastPresence.get(uid);
        lastPresence.set(uid, status);

        if (settings.store.notifyOnline && !isBoot()) {
            if (prev && prev !== "online" && status === "online") {
                const user = UserStore.getUser(uid);
                push({
                    id: `online-${uid}`,
                    type: "friend_online",
                    priority: Priority.Low,
                    title: userLabel(user, uid),
                    avatarUrl: avatarURL(user),
                    accent: "#23a55a",
                    duration: defaultDuration(),
                    userId: uid
                });
            }
        }

        if (settings.store.notifyActivity && !isBoot()) {
            const acts: any[] = u.activities ?? [];
            const main = acts.find(a => a.type === 0 || a.type === 1 || a.type === 2 || a.type === 3);
            const sig = main ? `${main.type}:${main.name ?? ""}:${main.details ?? ""}` : "";
            const prevSig = lastActivities.get(uid) ?? "";
            if (sig && sig !== prevSig) {
                const user = UserStore.getUser(uid);
                push({
                    id: `activity-${uid}`,
                    type: "friend_activity",
                    priority: Priority.Low,
                    title: userLabel(user, uid),
                    subtitle: [main.name, main.details].filter(Boolean).join(" — "),
                    avatarUrl: avatarURL(user),
                    accent: "#3b82f6",
                    duration: defaultDuration(),
                    userId: uid
                });
            }
            lastActivities.set(uid, sig);
        }
    }
}

// === Source: soundboard in shared VC ===
function handleSoundboardSend(event: any) {
    if (!settings.store.notifySoundboard) return;
    const me = selfId();
    if (!me || event.userId === me) return;
    const myVoiceCh = (() => {
        try { return SelectedChannelStore.getVoiceChannelId?.() ?? null; } catch { return null; }
    })();
    if (!myVoiceCh || event.channelId !== myVoiceCh) return;
    // In shared VC → show for everyone (this is the user's expectation when
    // they're sitting in a call together). Tracked-only would feel arbitrary here.
    const u = UserStore.getUser(event.userId);
    push({
        type: "soundboard",
        priority: Priority.Low,
        title: userLabel(u, event.userId),
        subtitle: event.emoji?.name || undefined,
        avatarUrl: avatarURL(u),
        icon: "🔊",
        accent: "#f47b67",
        duration: 4000,
        userId: event.userId,
        channelId: event.channelId
    });
}

// === Public API: still exposed for other plugins to push manually ===
declare global {
    interface Window {
        DynamicIsland?: {
            push: typeof push;
            dismiss: typeof dismiss;
            dismissByType: typeof dismissByType;
            onEvent: typeof onPushEvent;
            Priority: typeof Priority;
        };
    }
}

export default definePlugin({
    name: "DynamicIsland",
    description: "iOS-style notification pill at the top of Discord. Surfaces messages, voice activity, presence, streams, and soundboard plays — but only for users you track via UserStalker.",
    authors: [EquicordDevs.Matti],
    settings,
    dependencies: ["UserStalker"],

    start() {
        bootTs = Date.now();
        logger.info("DynamicIsland starting");

        // Host element on document.body — but we mount React inside a shadow root
        // so System24/BetterDiscord/any user theme can't reach our CSS.
        container = document.createElement("div");
        container.id = "dynamic-island-host";
        document.body.appendChild(container);

        const shadow = container.attachShadow({ mode: "open" });

        const styleEl = document.createElement("style");
        try {
            styleEl.textContent = requireStyle(islandStyleName).source;
        } catch (e) {
            logger.error("could not load Island.css source", e);
        }
        shadow.appendChild(styleEl);

        const mount = document.createElement("div");
        shadow.appendChild(mount);

        root = createRoot(mount);
        root.render(<Island />);

        window.DynamicIsland = { push, dismiss, dismissByType, onEvent: onPushEvent, Priority };

        startLiveActivities();
    },

    stop() {
        stopLiveActivities();
        if (root) { root.unmount(); root = null; }
        if (container) { container.remove(); container = null; }
        lastPresence.clear();
        lastActivities.clear();
        lastVoiceChannel.clear();
        streamingNow.clear();
        delete window.DynamicIsland;
    },

    flux: {
        MESSAGE_CREATE(p: any) { try { handleMessageCreate(p); } catch (e) { logger.error("MESSAGE_CREATE", e); } },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: any[]; }) {
            try { handleVoiceStates(voiceStates); } catch (e) { logger.error("VOICE_STATE_UPDATES", e); }
        },
        PRESENCE_UPDATES({ updates }: { updates: any[]; }) {
            try { handlePresenceUpdates(updates); } catch (e) { logger.error("PRESENCE_UPDATES", e); }
        },
        VOICE_CHANNEL_EFFECT_SEND(p: any) { try { handleSoundboardSend(p); } catch (e) { logger.error("VOICE_CHANNEL_EFFECT_SEND", e); } }
    }
});
