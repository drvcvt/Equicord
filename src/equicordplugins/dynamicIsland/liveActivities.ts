/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ChannelStore, DraftStore, FluxDispatcher, GuildStore, NavigationRouter, SelectedChannelStore, UserStore } from "@webpack/common";

import settings from "./settings";
import { dismiss, getById, push } from "./store";
import { Priority } from "./types";

const logger = new Logger("DynamicIsland.live", "#a78bfa");

const LIVE_VOICE_ID = "live-voice";
const LIVE_STREAM_ID = "live-stream";
const draftIds = new Set<string>(); // active draft event ids

function selfId(): string | undefined {
    try { return UserStore.getCurrentUser()?.id; } catch { return undefined; }
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

// === Voice call live activity =============================================

let lastVoiceChannelId: string | null = null;

export function reconcileVoiceLive() {
    if (!settings.store.liveVoiceCall) {
        if (getById(LIVE_VOICE_ID)) dismiss(LIVE_VOICE_ID);
        lastVoiceChannelId = null;
        return;
    }

    let channelId: string | null = null;
    try { channelId = SelectedChannelStore.getVoiceChannelId?.() ?? null; } catch { /* not ready */ }

    if (channelId === lastVoiceChannelId && (channelId ? !!getById(LIVE_VOICE_ID) : !getById(LIVE_VOICE_ID))) {
        return;
    }
    lastVoiceChannelId = channelId;

    if (!channelId) {
        dismiss(LIVE_VOICE_ID);
        return;
    }

    const ch = ChannelStore.getChannel(channelId);
    push({
        id: LIVE_VOICE_ID,
        type: "call",
        priority: Priority.Low,
        live: true,
        liveType: "voice_call",
        title: channelLabel(channelId),
        subtitle: ch?.guild_id ? guildLabel(ch.guild_id) : undefined,
        accent: "#23a55a",
        channelId,
        guildId: ch?.guild_id ?? undefined
    });
}

// === Stream live activity =================================================
// Only used when streaming WITHOUT a voice channel (rare). When in a VC the
// voice-call pill renders the stream state inline so the user only sees one pill.

let lastStreaming = false;

export function reconcileStreamLive(selfStream: boolean | null) {
    let inVc = false;
    try { inVc = !!SelectedChannelStore.getVoiceChannelId?.(); } catch { /* */ }
    const shouldShow = !!selfStream && !inVc && settings.store.liveScreenShare;

    if (shouldShow === lastStreaming && (shouldShow ? !!getById(LIVE_STREAM_ID) : !getById(LIVE_STREAM_ID))) {
        return;
    }
    lastStreaming = shouldShow;

    if (!shouldShow) {
        dismiss(LIVE_STREAM_ID);
        return;
    }
    push({
        id: LIVE_STREAM_ID,
        type: "stream_start",
        priority: Priority.Low,
        live: true,
        liveType: "stream",
        title: "Streaming",
        accent: "#ed4245"
    });
}

// === Draft tracker live activity ==========================================

const DRAFT_TYPE_CHANNEL = 0; // ChannelMessage
const MIN_DRAFT_LEN = 3;
const MAX_DRAFT_TRACKERS = 3;

function draftIdFor(channelId: string) { return `live-draft-${channelId}`; }

function reconcileDrafts() {
    const active: Set<string> = new Set();
    if (!settings.store.liveDraftTracker) {
        for (const id of draftIds) dismiss(id);
        draftIds.clear();
        return;
    }

    const currentChannel = (() => {
        try { return SelectedChannelStore.getChannelId(); } catch { return null; }
    })();

    // DraftStore.getState().drafts: { [userId]: { [channelId]: { 0: text } } }
    let drafts: Record<string, Record<string, Record<number, string>>> = {};
    try { drafts = (DraftStore as any).getState?.()?.drafts ?? {}; } catch { /* */ }

    const me = selfId();
    if (!me) return;

    const myDrafts = drafts[me] ?? {};
    const candidates: Array<{ channelId: string; text: string; }> = [];
    for (const [channelId, byType] of Object.entries(myDrafts)) {
        if (channelId === currentChannel) continue; // don't show for active channel
        const text = byType?.[DRAFT_TYPE_CHANNEL];
        if (!text || text.trim().length < MIN_DRAFT_LEN) continue;
        candidates.push({ channelId, text });
    }
    candidates.sort((a, b) => b.text.length - a.text.length);
    const top = candidates.slice(0, MAX_DRAFT_TRACKERS);

    for (const { channelId, text } of top) {
        const id = draftIdFor(channelId);
        active.add(id);
        const ch = ChannelStore.getChannel(channelId);
        push({
            id,
            type: "custom",
            priority: Priority.Low,
            live: true,
            liveType: "draft",
            title: `Draft in ${channelLabel(channelId)}`,
            subtitle: `${text.trim().slice(0, 60)}${text.length > 60 ? "…" : ""}`,
            body: `${text.length} chars`,
            accent: "#9ea0a8",
            channelId,
            guildId: ch?.guild_id ?? undefined,
            onClick: () => {
                NavigationRouter.transitionTo(`/channels/${ch?.guild_id ?? "@me"}/${channelId}`);
            }
        });
    }

    // Dismiss drafts that no longer exist
    for (const id of [...draftIds]) {
        if (!active.has(id)) {
            dismiss(id);
            draftIds.delete(id);
        }
    }
    for (const id of active) draftIds.add(id);
}

// === Public hooks =========================================================

let unsubFns: Array<() => void> = [];

export function startLiveActivities() {
    setTimeout(() => {
        reconcileVoiceLive();
        reconcileDrafts();
    }, 1500);

    const draftSub = () => reconcileDrafts();
    try {
        DraftStore.addChangeListener(draftSub);
        unsubFns.push(() => { try { DraftStore.removeChangeListener(draftSub); } catch { /* */ } });
    } catch (e) { logger.error("DraftStore subscribe failed", e); }

    const selSub = () => { reconcileDrafts(); reconcileVoiceLive(); };
    try {
        SelectedChannelStore.addChangeListener(selSub);
        unsubFns.push(() => { try { SelectedChannelStore.removeChangeListener(selSub); } catch { /* */ } });
    } catch (e) { logger.error("SelectedChannelStore subscribe failed", e); }

    const draftEventHandler = () => reconcileDrafts();
    FluxDispatcher.subscribe("DRAFT_SAVE", draftEventHandler);
    FluxDispatcher.subscribe("DRAFT_CLEAR", draftEventHandler);
    FluxDispatcher.subscribe("DRAFT_CHANGE", draftEventHandler);
    unsubFns.push(() => {
        try { FluxDispatcher.unsubscribe("DRAFT_SAVE", draftEventHandler); } catch { /* */ }
        try { FluxDispatcher.unsubscribe("DRAFT_CLEAR", draftEventHandler); } catch { /* */ }
        try { FluxDispatcher.unsubscribe("DRAFT_CHANGE", draftEventHandler); } catch { /* */ }
    });
}

export function stopLiveActivities() {
    for (const fn of unsubFns) fn();
    unsubFns = [];
    if (getById(LIVE_VOICE_ID)) dismiss(LIVE_VOICE_ID);
    if (getById(LIVE_STREAM_ID)) dismiss(LIVE_STREAM_ID);
    for (const id of draftIds) dismiss(id);
    draftIds.clear();
    lastVoiceChannelId = null;
    lastStreaming = false;
}

/** Re-evaluate live activities now (e.g. settings changed). */
export function refreshLiveActivities() {
    reconcileVoiceLive();
    reconcileDrafts();
}

/**
 * Called from index.tsx VOICE_STATE_UPDATES handler with self-only state.
 * Reconciles voice + stream live activities.
 */
export function onSelfVoiceStateUpdate(selfStream: boolean) {
    reconcileVoiceLive();
    reconcileStreamLive(selfStream);
}
