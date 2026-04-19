/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openUserProfile } from "@utils/discord";
import { Button, ChannelStore, GuildStore, React, ScrollerThin, TextInput, UserStore } from "@webpack/common";

import { computeHeatmap, computeStats, formatDuration, formatRelative } from "../stats";
import { clearUser, countOnDisk, getEntries, getLiveSession, getTracked, loadFullHistory, removeTracked, setTrackedNotify } from "../store";
import { StalkerEntry, StalkerEntryType } from "../types";
import { EntryRow } from "./EntryRow";

const FILTER_OPTIONS: Array<{ label: string; types: StalkerEntryType[]; }> = [
    { label: "All", types: [] },
    { label: "Messages", types: ["message", "message_edit", "message_delete"] },
    { label: "Voice", types: ["voice_join", "voice_leave", "voice_move", "voice_mute", "voice_deaf", "voice_video", "voice_stream", "voice_soundboard"] },
    { label: "Presence", types: ["presence"] },
    { label: "Activities", types: ["activity_start", "activity_stop"] }
];

function StatCard({ title, value, sub }: { title: string; value: string | number; sub?: string; }) {
    return (
        <div className="vc-stalker-stat">
            <div className="vc-stalker-stat-title">{title}</div>
            <div className="vc-stalker-stat-value">{value}</div>
            {sub && <div className="vc-stalker-stat-sub">{sub}</div>}
        </div>
    );
}

const DAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function triggerDownload(filename: string, contents: string, mime: string) {
    const blob = new Blob([contents], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCsv(entries: StalkerEntry[]): string {
    const header = ["timestamp_iso", "type", "userId", "guildId", "channelId", "content", "duration_ms", "extra"];
    const esc = (v: unknown) => {
        if (v === undefined || v === null) return "";
        const s = typeof v === "string" ? v : JSON.stringify(v);
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const rows = entries.map(e => {
        const { type, userId, guildId, channelId, timestamp } = e;
        const { content } = (e as any);
        const duration = (e as any).durationMs;
        const extra = { ...e };
        delete (extra as any).type;
        delete (extra as any).userId;
        delete (extra as any).guildId;
        delete (extra as any).channelId;
        delete (extra as any).timestamp;
        delete (extra as any).content;
        delete (extra as any).durationMs;
        return [
            new Date(timestamp).toISOString(),
            type,
            userId,
            guildId ?? "",
            channelId ?? "",
            content ?? "",
            duration ?? "",
            Object.keys(extra).length ? JSON.stringify(extra) : ""
        ].map(esc).join(",");
    });
    return [header.join(","), ...rows].join("\n");
}

function Heatmap({ entries }: { entries: StalkerEntry[]; }) {
    const grid = React.useMemo(() => computeHeatmap(entries), [entries]);
    const max = React.useMemo(() => {
        let m = 0;
        for (const row of grid) for (const v of row) if (v > m) m = v;
        return m || 1;
    }, [grid]);
    return (
        <div className="vc-stalker-heatmap">
            <div className="vc-stalker-heatmap-title">Activity heatmap (day of week × hour, local time)</div>
            <div className="vc-stalker-heatmap-grid">
                <div className="vc-stalker-heatmap-corner" />
                {Array.from({ length: 24 }, (_, h) => (
                    <div key={`h-${h}`} className="vc-stalker-heatmap-hlabel">{h % 3 === 0 ? h : ""}</div>
                ))}
                {grid.map((row, dow) => (
                    <React.Fragment key={`d-${dow}`}>
                        <div className="vc-stalker-heatmap-dlabel">{DAY_LABELS[dow]}</div>
                        {row.map((v, h) => {
                            const intensity = v === 0 ? 0 : Math.max(0.1, v / max);
                            return (
                                <div
                                    key={`c-${dow}-${h}`}
                                    className="vc-stalker-heatmap-cell"
                                    style={{ background: v === 0 ? "var(--background-modifier-accent)" : `rgba(88, 101, 242, ${intensity})` }}
                                    title={`${DAY_LABELS[dow]} ${h}:00 — ${v} event${v === 1 ? "" : "s"}`}
                                />
                            );
                        })}
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
}

export function UserPanel({ userId }: { userId: string; }) {
    const [filter, setFilter] = React.useState<string>("All");
    const [search, setSearch] = React.useState("");
    const [diskCount, setDiskCount] = React.useState<number | null>(null);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [, tick] = React.useReducer((n: number) => n + 1, 0);

    React.useEffect(() => {
        const id = setInterval(() => tick(), 1000);
        return () => clearInterval(id);
    }, []);

    React.useEffect(() => {
        let cancelled = false;
        countOnDisk(userId).then(n => { if (!cancelled) setDiskCount(n); });
        return () => { cancelled = true; };
    }, [userId]);

    const user = UserStore.getUser(userId);
    const tracked = getTracked()[userId];
    const entries = getEntries(userId);
    const live = getLiveSession(userId);

    const filteredTypes = FILTER_OPTIONS.find(f => f.label === filter)?.types ?? [];
    const visible = React.useMemo(() => {
        const base = filteredTypes.length === 0
            ? entries
            : entries.filter(e => filteredTypes.includes(e.type));
        const q = search.trim().toLowerCase();
        if (!q) return [...base].reverse();
        return [...base].reverse().filter(e => {
            if (e.type === "message" || e.type === "message_edit") {
                if (e.content?.toLowerCase().includes(q)) return true;
            }
            const ch = e.channelId ? ChannelStore.getChannel(e.channelId) : null;
            if (ch?.name?.toLowerCase().includes(q)) return true;
            const g = e.guildId ? GuildStore.getGuild(e.guildId) : null;
            if (g?.name?.toLowerCase().includes(q)) return true;
            return false;
        });
    }, [entries, filter, search]);

    const stats = React.useMemo(() => computeStats(entries), [entries]);

    const addedAt = tracked?.addedAt ? new Date(tracked.addedAt).toLocaleDateString() : "—";

    return (
        <div className="vc-stalker-userpanel">
            <div className="vc-stalker-userhead">
                <div className="vc-stalker-userhead-main">
                    <div className="vc-stalker-userhead-name">
                        {user?.globalName ?? user?.username ?? userId}
                    </div>
                    <div className="vc-stalker-userhead-sub">
                        {user?.username && `@${user.username} · `}
                        {userId} · tracked since {addedAt}
                    </div>
                </div>
                <div className="vc-stalker-userhead-actions">
                    <Button
                        size={Button.Sizes.SMALL}
                        color={tracked?.notify ?? true ? Button.Colors.GREEN : Button.Colors.PRIMARY}
                        onClick={() => setTrackedNotify(userId, !(tracked?.notify ?? true))}
                    >
                        {tracked?.notify ?? true ? "Notifying" : "Silent"}
                    </Button>
                    <Button size={Button.Sizes.SMALL} onClick={() => openUserProfile(userId)}>
                        Profile
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        onClick={() => {
                            const name = user?.username ?? userId;
                            triggerDownload(`stalker-${name}-${userId}.json`, JSON.stringify(entries, null, 2), "application/json");
                        }}
                    >
                        Export JSON
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        onClick={() => {
                            const name = user?.username ?? userId;
                            triggerDownload(`stalker-${name}-${userId}.csv`, toCsv(entries), "text/csv");
                        }}
                    >
                        Export CSV
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => clearUser(userId)}>
                        Clear log
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => removeTracked(userId, true)}>
                        Untrack
                    </Button>
                </div>
            </div>

            {live && (
                <div className="vc-stalker-live">
                    <span className="vc-stalker-live-dot" />
                    <span className="vc-stalker-live-text">
                        LIVE in {ChannelStore.getChannel(live.channelId)?.name ?? live.channelId} · {formatDuration(Date.now() - live.joinedAt)}
                    </span>
                </div>
            )}

            <div className="vc-stalker-stats">
                <StatCard title="Total events" value={stats.total} />
                <StatCard title="Messages" value={stats.messages} sub={`${stats.messagesLast24h} last 24h · ${stats.messagesLast7Days} last 7d`} />
                <StatCard title="VC sessions" value={stats.voiceSessions} sub={`avg ${formatDuration(stats.voiceAvgMs)}`} />
                <StatCard
                    title="VC time (7d)"
                    value={formatDuration(stats.voiceLast7DaysMs + (live ? Date.now() - live.joinedAt : 0))}
                    sub={`24h: ${formatDuration(stats.voiceLast24hMs + (live ? Date.now() - live.joinedAt : 0))}`}
                />
                <StatCard title="Last seen" value={live ? "now" : (stats.lastSeen ? formatRelative(stats.lastSeen) : "never")} />
                <StatCard title="First seen" value={stats.firstSeen ? formatRelative(stats.firstSeen) : "never"} />
            </div>

            <Heatmap entries={entries} />

            <div className="vc-stalker-toplists">
                <div className="vc-stalker-toplist">
                    <div className="vc-stalker-toplist-title">Top channels</div>
                    <div className="vc-stalker-toplist-body">
                        {stats.topChannels.length === 0 && <div className="vc-stalker-empty-mini">no data</div>}
                        {stats.topChannels.map(t => (
                            <div key={t.channelId} className="vc-stalker-toplist-row">
                                <span>{ChannelStore.getChannel(t.channelId)?.name ?? t.channelId}</span>
                                <span>{t.count}</span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="vc-stalker-toplist">
                    <div className="vc-stalker-toplist-title">Top servers</div>
                    <div className="vc-stalker-toplist-body">
                        {stats.topGuilds.length === 0 && <div className="vc-stalker-empty-mini">no data</div>}
                        {stats.topGuilds.map(t => (
                            <div key={t.guildId} className="vc-stalker-toplist-row">
                                <span>{GuildStore.getGuild(t.guildId)?.name ?? t.guildId}</span>
                                <span>{t.count}</span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="vc-stalker-toplist">
                    <div className="vc-stalker-toplist-title">Top VC buddies</div>
                    <div className="vc-stalker-toplist-body">
                        {stats.topCoVcUsers.length === 0 && <div className="vc-stalker-empty-mini">no data</div>}
                        {stats.topCoVcUsers.map(t => (
                            <div key={t.userId} className="vc-stalker-toplist-row">
                                <span>{UserStore.getUser(t.userId)?.username ?? t.userId}</span>
                                <span>{t.count}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="vc-stalker-filterbar">
                {FILTER_OPTIONS.map(f => (
                    <button
                        key={f.label}
                        className={"vc-stalker-filter-btn" + (filter === f.label ? " active" : "")}
                        onClick={() => setFilter(f.label)}
                    >
                        {f.label}
                    </button>
                ))}
                <TextInput
                    placeholder="Search content / channel / server..."
                    value={search}
                    onChange={setSearch}
                    className="vc-stalker-search"
                />
            </div>

            <ScrollerThin className="vc-stalker-entries" fade>
                {visible.length === 0
                    ? <div className="vc-stalker-empty">No entries match this filter.</div>
                    : visible.map((e, i) => <EntryRow key={`${e.timestamp}-${i}`} entry={e} />)}
                {diskCount !== null && diskCount > entries.length && (
                    <div className="vc-stalker-loadmore">
                        <span>Showing {entries.length} of {diskCount} entries on disk</span>
                        <Button
                            size={Button.Sizes.SMALL}
                            disabled={loadingMore}
                            onClick={async () => {
                                setLoadingMore(true);
                                const n = await loadFullHistory(userId);
                                setDiskCount(n);
                                setLoadingMore(false);
                            }}
                        >
                            {loadingMore ? "Loading…" : "Load full history"}
                        </Button>
                    </div>
                )}
            </ScrollerThin>
        </div>
    );
}
