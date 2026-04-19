/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore, PresenceStore, React, UserStore } from "@webpack/common";

import { formatDuration, formatRelative } from "../stats";
import { getEntries, getLiveSession, getTracked, getTyping } from "../store";

type Status = "online" | "idle" | "dnd" | "offline";

const STATUS_COLOR: Record<Status, string> = {
    online: "#3ba55d",
    idle: "#faa61a",
    dnd: "#ed4245",
    offline: "#747f8d"
};

const STATUS_LABEL: Record<Status, string> = {
    online: "Online",
    idle: "Idle",
    dnd: "Do not disturb",
    offline: "Offline"
};

function getStatus(userId: string): Status {
    try {
        return (PresenceStore.getStatus(userId) as Status) || "offline";
    } catch {
        return "offline";
    }
}

function lastActivityTs(userId: string): number | undefined {
    const entries = getEntries(userId);
    for (let i = entries.length - 1; i >= 0; i--) {
        const t = entries[i].type;
        if (t === "message" || t === "voice_join" || t === "voice_leave" || t === "presence") {
            return entries[i].timestamp;
        }
    }
    return undefined;
}

function channelLabel(id?: string | null): string {
    if (!id) return "?";
    const ch = ChannelStore.getChannel(id);
    return ch?.name ? `#${ch.name}` : id;
}

function guildLabel(id?: string | null): string {
    if (!id) return "DM";
    return GuildStore.getGuild(id)?.name ?? id;
}

function SummaryTile({ value, label, accent }: { value: number; label: string; accent?: string; }) {
    return (
        <div className="vc-stalker-now-tile" style={accent ? { borderTopColor: accent } : undefined}>
            <div className="vc-stalker-now-tile-value" style={accent ? { color: accent } : undefined}>{value}</div>
            <div className="vc-stalker-now-tile-label">{label}</div>
        </div>
    );
}

function UserCard({ userId, status, live, lastTs, onClick }: {
    userId: string;
    status: Status;
    live: ReturnType<typeof getLiveSession>;
    lastTs?: number;
    onClick: () => void;
}) {
    const typing = getTyping(userId);
    const tracked = getTracked()[userId];
    const u = UserStore.getUser(userId);
    const name = u?.globalName ?? u?.username ?? tracked?.username ?? userId;
    const avatarUrl = u?.getAvatarURL?.(undefined, 64, false);

    return (
        <div
            className={"vc-stalker-now-card" + (live ? " live" : "") + ` status-${status}`}
            onClick={onClick}
            title={`Click to open ${name}'s log`}
        >
            <div className="vc-stalker-now-card-avatar">
                {avatarUrl
                    ? <img src={avatarUrl} alt="" />
                    : <div className="vc-stalker-now-card-avatar-fallback">{name.slice(0, 1).toUpperCase()}</div>}
                <span className="vc-stalker-now-card-status" style={{ background: STATUS_COLOR[status] }} />
            </div>
            <div className="vc-stalker-now-card-body">
                <div className="vc-stalker-now-card-name">{name}</div>
                {live
                    ? (
                        <div className="vc-stalker-now-card-action live">
                            <span className="vc-stalker-now-card-icon">🎙</span>
                            <span>{channelLabel(live.channelId)}</span>
                            <span className="vc-stalker-now-card-muted">· {formatDuration(Date.now() - live.joinedAt)}</span>
                        </div>
                    )
                    : typing
                        ? (
                            <div className="vc-stalker-now-card-action vc-stalker-now-typing">
                                <span className="vc-stalker-now-card-icon">✍</span>
                                <span>typing in {channelLabel(typing.channelId)}</span>
                            </div>
                        )
                        : (
                            <div className="vc-stalker-now-card-action">
                                <span className="vc-stalker-now-card-muted">
                                    {status === "offline"
                                        ? (lastTs ? `last seen ${formatRelative(lastTs)}` : "never seen")
                                        : STATUS_LABEL[status]}
                                </span>
                            </div>
                        )}
                {live && (
                    <div className="vc-stalker-now-card-sub">{guildLabel(live.guildId)}</div>
                )}
            </div>
        </div>
    );
}

export function NowWidget({ onSelectUser }: { onSelectUser: (id: string) => void; }) {
    const [, tick] = React.useReducer((n: number) => n + 1, 0);

    React.useEffect(() => {
        const id = setInterval(() => tick(), 3000);
        return () => clearInterval(id);
    }, []);

    const tracked = getTracked();
    const ids = Object.keys(tracked);

    if (ids.length === 0) return null;

    const statuses = ids.map(id => ({
        id,
        status: getStatus(id),
        live: getLiveSession(id),
        lastTs: lastActivityTs(id)
    }));

    const online = statuses.filter(s => s.status === "online").length;
    const idle = statuses.filter(s => s.status === "idle").length;
    const dnd = statuses.filter(s => s.status === "dnd").length;
    const inVc = statuses.filter(s => s.live).length;

    const sortRank = (s: typeof statuses[number]) => {
        if (s.live) return 0;
        if (s.status === "online") return 1;
        if (s.status === "idle") return 2;
        if (s.status === "dnd") return 3;
        return 4;
    };
    const sorted = [...statuses].sort((a, b) => {
        const r = sortRank(a) - sortRank(b);
        if (r !== 0) return r;
        return (b.lastTs ?? 0) - (a.lastTs ?? 0);
    });

    return (
        <div className="vc-stalker-now">
            <div className="vc-stalker-now-header">
                <div
                    className="vc-stalker-now-title"
                    style={{
                        // inline fallback colors + sizing so the title always shows
                        // even if the plugin stylesheet didn't load yet or a theme
                        // overrides the var.
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: "1.2px",
                        textTransform: "uppercase",
                        color: "var(--header-primary, #fff)"
                    }}
                >
                    Right now
                </div>
                <div className="vc-stalker-now-subtitle" style={{ fontSize: 11, color: "var(--text-muted, #a3a6aa)" }}>
                    Live snapshot of all tracked users
                </div>
            </div>

            <div className="vc-stalker-now-tiles">
                <SummaryTile value={ids.length} label="Tracked" />
                <SummaryTile value={inVc} label="In voice" accent={STATUS_COLOR.online} />
                <SummaryTile value={online} label="Online" accent={STATUS_COLOR.online} />
                <SummaryTile value={idle} label="Idle" accent={STATUS_COLOR.idle} />
                <SummaryTile value={dnd} label="DND" accent={STATUS_COLOR.dnd} />
                <SummaryTile value={ids.length - online - idle - dnd} label="Offline" accent={STATUS_COLOR.offline} />
            </div>

            <div className="vc-stalker-now-cards">
                {sorted.map(s => (
                    <UserCard
                        key={s.id}
                        userId={s.id}
                        status={s.status}
                        live={s.live}
                        lastTs={s.lastTs}
                        onClick={() => onSelectUser(s.id)}
                    />
                ))}
            </div>
        </div>
    );
}
