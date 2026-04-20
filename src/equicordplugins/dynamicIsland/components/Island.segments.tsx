/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findByCodeLazy } from "@webpack";
import {
    ApplicationStreamingStore,
    ChannelActions,
    ChannelStore,
    FluxDispatcher,
    GuildStore,
    MediaEngineStore,
    NavigationRouter,
    React,
    useStateFromStores,
    UserStore,
    VoiceActions,
    VoiceStateStore
} from "@webpack/common";

import { dismiss } from "../store";
import { IslandEvent } from "../types";
import {
    Avatar,
    CheckIcon,
    DiscordDot,
    HeadphoneIcon,
    Marquee,
    MicIcon,
    MixerIcon,
    QueueDots,
    StopIcon,
    TypeBadge,
    Waveform
} from "./Island.parts";
import { PillDragHandle } from "./Island.reply";
import { AvatarStack, buildStreamKey, SelfAvatar, useSelfSpeaking, VoiceMixer } from "./Island.voice";

const logger = new Logger("DynamicIsland.seg", "#a78bfa");
const stopStream = findByCodeLazy('type:"STREAM_STOP"');

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

// === Idle segment ==========================================================

export function IdleSegment({ onClick }: { onClick?: () => void; }) {
    return (
        <div
            className="di-segment di-segment-idle"
            onClick={e => { e.stopPropagation(); onClick?.(); }}
            role={onClick ? "button" : undefined}
        >
            <div className="di-idle-dot">
                <DiscordDot />
            </div>
        </div>
    );
}

// === Active voice call panel (rendered when idle dot clicked) =============

interface ActiveCall {
    channelId: string;
    guildId: string | null;
    userIds: string[];
}

function useActiveCalls(): ActiveCall[] {
    return useStateFromStores([VoiceStateStore], () => {
        let me: string | undefined;
        try { me = UserStore.getCurrentUser()?.id; } catch { /* */ }
        const byChannel = new Map<string, ActiveCall>();
        const all = (VoiceStateStore as any).getAllVoiceStates?.() ?? {};
        // Shape varies across Discord versions — handle both flat { userId -> state }
        // and nested { guildId -> { userId -> state } }.
        const consider = (userId: string, state: any) => {
            if (!state || typeof state !== "object") return;
            const channelId: string | undefined = state.channelId;
            if (!channelId) return;
            if (userId === me) return;
            let entry = byChannel.get(channelId);
            if (!entry) {
                entry = { channelId, guildId: state.guildId ?? null, userIds: [] };
                byChannel.set(channelId, entry);
            }
            if (!entry.userIds.includes(userId)) entry.userIds.push(userId);
        };
        for (const k of Object.keys(all)) {
            const v = all[k];
            if (v && typeof v === "object" && typeof v.channelId !== "undefined") {
                consider(k, v);
            } else if (v && typeof v === "object") {
                for (const uid of Object.keys(v)) consider(uid, v[uid]);
            }
        }
        return [...byChannel.values()]
            .filter(c => c.userIds.length > 0)
            .sort((a, b) => b.userIds.length - a.userIds.length)
            .slice(0, 8);
    });
}

function CallRow({ call, onJoin }: { call: ActiveCall; onJoin: () => void; }) {
    const ch = ChannelStore.getChannel(call.channelId);
    const guild = call.guildId ? GuildStore.getGuild(call.guildId) : null;
    const name = ch?.name ? `#${ch.name}` : (ch?.type === 3 ? (ch.name || "Group DM") : "Voice");
    const sub = guild?.name ?? (ch?.type === 1 ? "DM" : ch?.type === 3 ? "Group" : "Voice");
    const shown = call.userIds.slice(0, 4);
    const overflow = Math.max(0, call.userIds.length - shown.length);

    return (
        <button className="di-idle-call" onClick={onJoin} title={`Join ${name}`}>
            <div className="di-idle-call-text">
                <span className="di-idle-call-name">{name}</span>
                <span className="di-idle-call-sub">{sub}</span>
            </div>
            <div className="di-idle-call-avatars">
                {shown.map(uid => {
                    const u = UserStore.getUser(uid) as any;
                    const url = u?.getAvatarURL?.(undefined, 32, false);
                    const letter = (u?.username?.[0] ?? "?").toUpperCase();
                    const title = u?.globalName || u?.global_name || u?.username || uid;
                    return url
                        ? <img key={uid} className="di-idle-call-avatar" src={url} alt="" title={title} />
                        : <div key={uid} className="di-idle-call-avatar di-idle-call-avatar-fallback" title={title}>{letter}</div>;
                })}
                {overflow > 0 && <div className="di-idle-call-avatar di-idle-call-avatar-more">+{overflow}</div>}
            </div>
            <span className="di-idle-call-join">Join</span>
        </button>
    );
}

export function IdlePanel({ active, onClose }: { active: boolean; onClose: () => void; }) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    const calls = useActiveCalls();

    React.useEffect(() => {
        const handler = (e: MouseEvent) => {
            const path = e.composedPath();
            if (path.some(n => n === ref.current)) return;
            // Don't close on clicks on the idle dot itself — that is the toggle
            if (path.some(n => (n as HTMLElement)?.classList?.contains?.("di-segment-idle"))) return;
            onClose();
        };
        document.addEventListener("mousedown", handler, { capture: true });
        return () => document.removeEventListener("mousedown", handler, { capture: true });
    }, [onClose]);

    const join = (call: ActiveCall) => {
        try {
            if (call.guildId) {
                ChannelActions.selectVoiceChannel(call.channelId);
            } else {
                // DM / group call → navigate and then join
                NavigationRouter.transitionTo(`/channels/@me/${call.channelId}`);
                ChannelActions.selectVoiceChannel(call.channelId);
            }
        } catch (e) {
            logger.error("join voice failed", e);
        }
        onClose();
    };

    return (
        <div
            ref={ref}
            className={"di-idle-panel" + (active ? " di-idle-panel-active" : "")}
            onMouseDown={e => e.stopPropagation()}
        >
            <div className="di-idle-panel-header">Active calls</div>
            {calls.length === 0 ? (
                <div className="di-idle-panel-empty">No one in a voice channel</div>
            ) : (
                <div className="di-idle-panel-list">
                    {calls.map(c => <CallRow key={c.channelId} call={c} onJoin={() => join(c)} />)}
                </div>
            )}
        </div>
    );
}

// === Voice segment =========================================================

export function VoiceSegment({ event, expanded, onMouseEnter }: {
    event: IslandEvent;
    expanded: boolean;
    onMouseEnter: () => void;
}) {
    const muted = useStateFromStores([MediaEngineStore], () => {
        try { return MediaEngineStore.isSelfMute(); } catch { return false; }
    });
    const deafened = useStateFromStores([MediaEngineStore], () => {
        try { return MediaEngineStore.isSelfDeaf(); } catch { return false; }
    });
    const myStream = useStateFromStores([ApplicationStreamingStore], () => {
        try { return ApplicationStreamingStore.getCurrentUserActiveStream?.() ?? null; } catch { return null; }
    });
    const viewerIds: string[] = useStateFromStores([ApplicationStreamingStore], () => {
        try {
            const s = ApplicationStreamingStore.getCurrentUserActiveStream?.();
            return s ? (ApplicationStreamingStore.getViewerIds?.(s) ?? []) : [];
        } catch { return []; }
    });
    const speaking = useSelfSpeaking();

    const streamKey = buildStreamKey(myStream);
    const [elapsed, setElapsed] = React.useState(0);
    React.useEffect(() => {
        if (!streamKey) { setElapsed(0); return; }
        const start = Date.now();
        const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
        tick();
        const t = setInterval(tick, 1000);
        return () => clearInterval(t);
    }, [streamKey]);

    return (
        <div
            className={"di-segment di-segment-voice" + (myStream ? " di-segment-streaming" : "")}
            onMouseEnter={onMouseEnter}
        >
            <div className="di-seg-compact">
                <SelfAvatar speaking={speaking} />
                <Waveform active={speaking} />
                <div className="di-seg-text">
                    <Marquee className="di-seg-title">{event.title}</Marquee>
                    {event.subtitle && <span className="di-seg-subtitle">{event.subtitle}</span>}
                </div>
                <div className="di-seg-state">
                    {myStream && (
                        <span className="di-rec-inline" title={`Streaming · ${fmtTime(elapsed)}`}>
                            <span className="di-rec-dot di-rec-dot-sm" />
                            <span className="di-rec-time">{fmtTime(elapsed)}</span>
                        </span>
                    )}
                    <span className={"di-state-icon" + (muted ? " di-state-off" : "")}>
                        <MicIcon muted={muted} />
                    </span>
                    <span className={"di-state-icon" + (deafened ? " di-state-off" : "")}>
                        <HeadphoneIcon deafened={deafened} />
                    </span>
                </div>
            </div>
            {expanded && myStream && viewerIds.length > 0 && (
                <div className="di-watchers-inline">
                    <AvatarStack userIds={viewerIds} max={4} />
                    <span className="di-watchers-label">{viewerIds.length} watching</span>
                </div>
            )}
        </div>
    );
}

export function VoiceExpandContent({ event }: { event: IslandEvent; }) {
    const [mixerOpen, setMixerOpen] = React.useState(false);
    const muted = useStateFromStores([MediaEngineStore], () => {
        try { return MediaEngineStore.isSelfMute(); } catch { return false; }
    });
    const deafened = useStateFromStores([MediaEngineStore], () => {
        try { return MediaEngineStore.isSelfDeaf(); } catch { return false; }
    });
    const myStream = useStateFromStores([ApplicationStreamingStore], () => {
        try { return ApplicationStreamingStore.getCurrentUserActiveStream?.() ?? null; } catch { return null; }
    });

    const leave = () => {
        try { ChannelActions.selectVoiceChannel(null); } catch { /* */ }
        dismiss(event.id);
    };

    const stopStreamFn = () => {
        const key = buildStreamKey(myStream);
        if (!key) return;
        try {
            if (typeof stopStream === "function") stopStream(key);
            else FluxDispatcher.dispatch({ type: "STREAM_STOP", streamKey: key });
        } catch (e) {
            logger.error("stop stream failed", e);
            try { FluxDispatcher.dispatch({ type: "STREAM_STOP", streamKey: key }); } catch { /* */ }
        }
    };

    return (
        <div className="di-expand-inner">
            <div className="di-expand-controls">
                <button
                    className={"di-ctrl-btn" + (muted ? " di-ctrl-btn-active" : "")}
                    onClick={() => VoiceActions.toggleSelfMute()}
                    title={muted ? "Unmute" : "Mute"}
                >
                    <MicIcon muted={muted} />
                </button>
                <button
                    className={"di-ctrl-btn" + (deafened ? " di-ctrl-btn-active" : "")}
                    onClick={() => VoiceActions.toggleSelfDeaf()}
                    title={deafened ? "Undeafen" : "Deafen"}
                >
                    <HeadphoneIcon deafened={deafened} />
                </button>
                {myStream && (
                    <button className="di-ctrl-btn di-ctrl-btn-active" onClick={stopStreamFn} title="Stop streaming">
                        <StopIcon />
                    </button>
                )}
                <button
                    className={"di-ctrl-btn" + (mixerOpen ? " di-ctrl-btn-on" : "")}
                    onClick={() => setMixerOpen(o => !o)}
                    title="Mixer"
                >
                    <MixerIcon />
                </button>
                <button className="di-ctrl-btn di-ctrl-btn-danger" onClick={leave} title="Leave voice channel">
                    Leave
                </button>
            </div>
            {mixerOpen && event.channelId && (
                <VoiceMixer channelId={event.channelId} onClose={() => setMixerOpen(false)} />
            )}
        </div>
    );
}

// === Stream segment (standalone — used only when streaming without VC) =====

export function StreamSegment({ event, onMouseEnter }: { event: IslandEvent; onMouseEnter: () => void; }) {
    const [elapsed, setElapsed] = React.useState(() => Math.floor((Date.now() - event.createdAt) / 1000));
    React.useEffect(() => {
        const t = setInterval(() => setElapsed(Math.floor((Date.now() - event.createdAt) / 1000)), 1000);
        return () => clearInterval(t);
    }, [event.id, event.createdAt]);

    const viewerCount = useStateFromStores([ApplicationStreamingStore], () => {
        try {
            const stream = ApplicationStreamingStore.getCurrentUserActiveStream?.();
            if (!stream) return 0;
            return ApplicationStreamingStore.getViewerIds?.(stream)?.length ?? 0;
        } catch { return 0; }
    });

    const stop = (ev?: React.MouseEvent) => {
        ev?.stopPropagation();
        try {
            const stream = ApplicationStreamingStore.getCurrentUserActiveStream?.();
            const key = buildStreamKey(stream);
            if (key) {
                if (typeof stopStream === "function") stopStream(key);
                else FluxDispatcher.dispatch({ type: "STREAM_STOP", streamKey: key });
            }
        } catch (e) { logger.error("stop stream", e); }
        dismiss(event.id);
    };

    return (
        <div className="di-segment di-segment-stream" onMouseEnter={onMouseEnter}>
            <div className="di-seg-compact">
                <div className="di-rec-dot" />
                <div className="di-seg-text">
                    <span className="di-seg-title">REC · {fmtTime(elapsed)}</span>
                    {(event.subtitle || viewerCount > 0) && (
                        <span className="di-seg-subtitle">
                            {event.subtitle}
                            {viewerCount > 0 && ` · ${viewerCount} watching`}
                        </span>
                    )}
                </div>
                <button className="di-ctrl-btn di-ctrl-btn-danger" onClick={stop} title="Stop streaming">
                    <StopIcon />
                </button>
            </div>
        </div>
    );
}

// === Draft segment =========================================================

export function DraftSegment({ event, onMouseEnter }: { event: IslandEvent; onMouseEnter: () => void; }) {
    const handleClick = () => {
        if (event.onClick) event.onClick();
        dismiss(event.id);
    };
    return (
        <div
            className="di-segment di-segment-draft"
            onMouseEnter={onMouseEnter}
            onClick={handleClick}
            role="button"
        >
            <div className="di-seg-compact">
                <div className="di-seg-icon-muted">✎</div>
                <div className="di-seg-text">
                    <Marquee className="di-seg-title">{event.title}</Marquee>
                    {event.subtitle && <Marquee className="di-seg-subtitle">{event.subtitle}</Marquee>}
                </div>
                <span className="di-seg-meta">{event.body}</span>
                <button
                    className="di-seg-x"
                    onClick={ev => { ev.stopPropagation(); dismiss(event.id); }}
                    aria-label="Hide"
                >×</button>
            </div>
        </div>
    );
}

// === Transient segment =====================================================

export interface TransientSegmentProps {
    event: IslandEvent;
    all: IslandEvent[];
    onMouseEnter: () => void;
    onClick: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onMouseDown: (e: React.MouseEvent) => void;
    onAuxClick: (e: React.MouseEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    dropTarget: boolean;
    onDismiss: () => void;
    onAck: () => void;
    onPopoutChange: (open: boolean) => void;
}

export function TransientSegment(p: TransientSegmentProps) {
    const { event, all, dropTarget } = p;
    return (
        <div
            className={"di-segment di-segment-transient" + (dropTarget ? " di-segment-drop" : "")}
            onMouseEnter={p.onMouseEnter}
            onClick={p.onClick}
            onContextMenu={p.onContextMenu}
            onMouseDown={p.onMouseDown}
            onAuxClick={p.onAuxClick}
            onDragOver={p.onDragOver}
            onDragLeave={p.onDragLeave}
            onDrop={p.onDrop}
        >
            <div className="di-seg-compact">
                <Avatar event={event} onPopoutChange={p.onPopoutChange} />
                <div className="di-seg-text">
                    <div className="di-seg-title-row">
                        <TypeBadge event={event} />
                        <Marquee className="di-seg-title">{event.title}</Marquee>
                    </div>
                    {event.subtitle && <Marquee className="di-seg-subtitle">{event.subtitle}</Marquee>}
                </div>
                <QueueDots all={all} activeId={event.id} />
                <PillDragHandle event={event} />
                {event.channelId && (
                    <button
                        className="di-ack"
                        onClick={ev => { ev.stopPropagation(); p.onAck(); }}
                        aria-label="Mark as read"
                        title="Mark channel as read"
                    ><CheckIcon /></button>
                )}
                <button
                    className="di-close"
                    onClick={ev => { ev.stopPropagation(); p.onDismiss(); }}
                    aria-label="Dismiss"
                >×</button>
            </div>
        </div>
    );
}

export function TransientExpandContent({ event }: { event: IslandEvent; }) {
    if (!event.body) return null;
    return (
        <div className="di-expand-inner">
            <div className="di-expand-body">{event.body}</div>
        </div>
    );
}
