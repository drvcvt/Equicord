/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { StalkerEntry } from "./types";

export interface UserStats {
    total: number;
    messages: number;
    voiceSessions: number;
    voiceTotalMs: number;
    voiceAvgMs: number;
    lastSeen?: number;
    firstSeen?: number;
    topChannels: Array<{ channelId: string; count: number; }>;
    topGuilds: Array<{ guildId: string; count: number; }>;
    topCoVcUsers: Array<{ userId: string; count: number; }>;
    messagesByHour: number[];
    messagesLast7Days: number;
    messagesLast24h: number;
    voiceLast7DaysMs: number;
    voiceLast24hMs: number;
    presenceBreakdown: Record<string, number>;
}

const DAY = 24 * 60 * 60 * 1000;

export function computeStats(entries: StalkerEntry[]): UserStats {
    const stats: UserStats = {
        total: entries.length,
        messages: 0,
        voiceSessions: 0,
        voiceTotalMs: 0,
        voiceAvgMs: 0,
        topChannels: [],
        topGuilds: [],
        topCoVcUsers: [],
        messagesByHour: new Array(24).fill(0),
        messagesLast7Days: 0,
        messagesLast24h: 0,
        voiceLast7DaysMs: 0,
        voiceLast24hMs: 0,
        presenceBreakdown: {}
    };

    const now = Date.now();
    const channelCounts = new Map<string, number>();
    const guildCounts = new Map<string, number>();
    const coVcCounts = new Map<string, number>();

    for (const e of entries) {
        if (!stats.firstSeen || e.timestamp < stats.firstSeen) stats.firstSeen = e.timestamp;
        if (!stats.lastSeen || e.timestamp > stats.lastSeen) stats.lastSeen = e.timestamp;

        if (e.type === "message") {
            stats.messages++;
            const h = new Date(e.timestamp).getHours();
            stats.messagesByHour[h]++;
            if (now - e.timestamp < 7 * DAY) stats.messagesLast7Days++;
            if (now - e.timestamp < DAY) stats.messagesLast24h++;
            if (e.channelId) channelCounts.set(e.channelId, (channelCounts.get(e.channelId) ?? 0) + 1);
            if (e.guildId) guildCounts.set(e.guildId, (guildCounts.get(e.guildId) ?? 0) + 1);
        } else if (e.type === "voice_join") {
            if (e.otherUserIds) {
                for (const u of e.otherUserIds) coVcCounts.set(u, (coVcCounts.get(u) ?? 0) + 1);
            }
        } else if (e.type === "voice_leave") {
            stats.voiceSessions++;
            if (e.durationMs) {
                stats.voiceTotalMs += e.durationMs;
                if (now - e.timestamp < 7 * DAY) stats.voiceLast7DaysMs += e.durationMs;
                if (now - e.timestamp < DAY) stats.voiceLast24hMs += e.durationMs;
            }
        } else if (e.type === "presence") {
            stats.presenceBreakdown[e.status] = (stats.presenceBreakdown[e.status] ?? 0) + 1;
        }
    }

    stats.voiceAvgMs = stats.voiceSessions > 0 ? Math.round(stats.voiceTotalMs / stats.voiceSessions) : 0;

    stats.topChannels = [...channelCounts.entries()]
        .map(([channelId, count]) => ({ channelId, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);

    stats.topGuilds = [...guildCounts.entries()]
        .map(([guildId, count]) => ({ guildId, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);

    stats.topCoVcUsers = [...coVcCounts.entries()]
        .map(([userId, count]) => ({ userId, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);

    return stats;
}

export function formatDuration(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rMins = mins % 60;
    if (hrs < 24) return `${hrs}h ${rMins}m`;
    const days = Math.floor(hrs / 24);
    const rHrs = hrs % 24;
    return `${days}d ${rHrs}h`;
}

/**
 * 7 rows (Mon..Sun) x 24 cols (hours). Counts messages + voice sessions.
 */
export function computeHeatmap(entries: StalkerEntry[]): number[][] {
    const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const e of entries) {
        if (e.type !== "message" && e.type !== "voice_join" && e.type !== "presence") continue;
        const d = new Date(e.timestamp);
        // JS getDay: 0 = Sun. Shift so Mon = 0.
        const dow = (d.getDay() + 6) % 7;
        const hour = d.getHours();
        grid[dow][hour]++;
    }
    return grid;
}

export function formatRelative(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(ts).toLocaleDateString();
}
