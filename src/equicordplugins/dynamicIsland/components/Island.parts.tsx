/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    GuildMemberStore,
    GuildStore,
    PresenceStore,
    React,
    UserProfileStore,
    UserStore
} from "@webpack/common";

import { getActive, getEvents, getLive, subscribe } from "../store";
import { IslandEvent, IslandEventType } from "../types";

export const TYPE_LABELS: Partial<Record<IslandEventType, string>> = {
    mention: "@MENTION",
    dm: "DM",
    stalker: "MSG",
    voice_join: "JOINED VC",
    voice_leave: "LEFT VC",
    voice_move: "MOVED VC",
    stream_start: "STREAMING",
    friend_online: "ONLINE",
    friend_activity: "ACTIVITY",
    soundboard: "SOUND",
    call: "CALL",
    reaction: "REACT"
};

export const STATUS_COLORS: Record<string, string> = {
    online: "#23a55a",
    idle: "#f0b232",
    dnd: "#f23f43",
    streaming: "#593695",
    offline: "#80848e",
    invisible: "#80848e"
};

// === Segment model =========================================================

export type SegmentType = "voice_call" | "stream" | "draft" | "transient" | "idle";

export interface SegmentData {
    id: string;
    type: SegmentType;
    event?: IslandEvent;
    compactWidth: number;
    priority: number;
}

export type TrackedSegment = { data: SegmentData; status: "in" | "out"; };

export function computeSegments(live: IslandEvent[], transient: IslandEvent | null): SegmentData[] {
    const out: SegmentData[] = [];
    for (const e of live) {
        if (e.liveType === "voice_call") {
            out.push({ id: e.id, type: "voice_call", event: e, compactWidth: 320, priority: 100 });
        }
    }
    for (const e of live) {
        if (e.liveType === "stream") {
            out.push({ id: e.id, type: "stream", event: e, compactWidth: 220, priority: 80 });
        }
    }
    for (const e of live) {
        if (e.liveType === "draft") {
            out.push({ id: e.id, type: "draft", event: e, compactWidth: 220, priority: 50 });
        }
    }
    if (transient) {
        out.push({
            id: `transient-${transient.id}`,
            type: "transient",
            event: transient,
            compactWidth: 340,
            priority: 10
        });
    }
    if (out.length === 0) {
        out.push({ id: "idle", type: "idle", compactWidth: 44, priority: 0 });
    }
    return out;
}

export function computeWidth(tracked: TrackedSegment[]): number {
    const active = tracked.filter(s => s.status !== "out");
    if (active.length === 0) return 44;
    if (active.length === 1 && active[0].data.type === "idle") return 44;
    const w = active.reduce((acc, s) => acc + s.data.compactWidth, 0);
    const dividers = Math.max(0, active.length - 1);
    return w + dividers + 24;
}

// === Hooks =================================================================

export function useIslandState() {
    const [, setTick] = React.useState(0);
    React.useEffect(() => subscribe(() => setTick(t => t + 1)), []);
    return { active: getActive(), all: getEvents().filter(e => !e.live), live: getLive() };
}

export function useAnimatedSegments(segments: SegmentData[], exitMs = 260): TrackedSegment[] {
    const [list, setList] = React.useState<TrackedSegment[]>(() =>
        segments.map(s => ({ data: s, status: "in" }))
    );

    React.useEffect(() => {
        setList(prev => {
            const currentIds = new Set(segments.map(s => s.id));
            const next: TrackedSegment[] = [];
            for (const t of prev) {
                if (currentIds.has(t.data.id)) {
                    const updated = segments.find(s => s.id === t.data.id)!;
                    next.push({ data: updated, status: "in" });
                } else if (t.status === "in") {
                    next.push({ data: t.data, status: "out" });
                    setTimeout(() => {
                        setList(l => l.filter(x => x.data.id !== t.data.id));
                    }, exitMs);
                } else {
                    next.push(t);
                }
            }
            const existing = new Set(next.map(t => t.data.id));
            for (const s of segments) if (!existing.has(s.id)) next.push({ data: s, status: "in" });
            return next;
        });
    }, [segments.map(s => s.id).join("|")]);

    return list;
}

/** Detects whether a child of the given ref is overflowing its parent, and returns a boolean. */
export function useOverflow(ref: React.RefObject<HTMLElement>, deps: any[]) {
    const [overflow, setOverflow] = React.useState(false);
    React.useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
        check();
        const ro = new ResizeObserver(check);
        ro.observe(el);
        return () => ro.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return overflow;
}

// === Icons =================================================================

export function SendIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
                d="M3 11l18-8-8 18-2-8-8-2z"
                stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
                fill="currentColor" fillOpacity="0.18"
            />
        </svg>
    );
}

export function CheckIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function GripIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
            <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
            <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
        </svg>
    );
}

export function MicIcon({ muted }: { muted: boolean; }) {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" fill="currentColor" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            {muted && <line x1="4" y1="4" x2="20" y2="20" stroke="#ed4245" strokeWidth="2.4" strokeLinecap="round" />}
        </svg>
    );
}

export function HeadphoneIcon({ deafened }: { deafened: boolean; }) {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14a2 2 0 0 1 2-2h2v6H6a2 2 0 0 1-2-2v-2zM20 14a2 2 0 0 0-2-2h-2v6h2a2 2 0 0 0 2-2v-2z" stroke="currentColor" strokeWidth="2" fill="currentColor" fillOpacity="0.2" />
            {deafened && <line x1="4" y1="4" x2="20" y2="20" stroke="#ed4245" strokeWidth="2.4" strokeLinecap="round" />}
        </svg>
    );
}

export function StopIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
    );
}

export function MixerIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M4 6h12M4 12h8M4 18h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="18" cy="6" r="2.2" fill="currentColor" />
            <circle cx="14" cy="12" r="2.2" fill="currentColor" />
            <circle cx="20" cy="18" r="2.2" fill="currentColor" />
        </svg>
    );
}

export function DiscordDot() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 4.5a18 18 0 0 0-4.6-1.4l-.2.4a16 16 0 0 1 4 2 14 14 0 0 0-12.4 0 16 16 0 0 1 4-2l-.2-.4A18 18 0 0 0 5 4.5a19 19 0 0 0-3 13 18 18 0 0 0 5.4 2.7l.4-.6a12 12 0 0 1-1.8-.9l.1-.1a13 13 0 0 0 11.8 0l.1.1a12 12 0 0 1-1.8.9l.4.6a18 18 0 0 0 5.4-2.7 19 19 0 0 0-3-13ZM9.5 15a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm5 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" />
        </svg>
    );
}

// === Marquee (auto-detects overflow) =======================================

export function Marquee({ children, className }: { children: React.ReactNode; className?: string; }) {
    const innerRef = React.useRef<HTMLSpanElement>(null);
    const outerRef = React.useRef<HTMLSpanElement>(null);
    const [active, setActive] = React.useState(false);
    React.useEffect(() => {
        const inner = innerRef.current, outer = outerRef.current;
        if (!inner || !outer) return;
        const check = () => setActive(inner.scrollWidth > outer.clientWidth + 1);
        check();
        const ro = new ResizeObserver(check);
        ro.observe(outer);
        ro.observe(inner);
        return () => ro.disconnect();
    }, [children]);
    return (
        <span ref={outerRef} className={"di-marquee " + (className ?? "") + (active ? " di-marquee-active" : "")}>
            <span ref={innerRef} className="di-marquee-inner">{children}</span>
        </span>
    );
}

// === Waveform ==============================================================

export function Waveform({ active }: { active: boolean; }) {
    return (
        <span className={"di-wave" + (active ? " di-wave-active" : "")} aria-hidden>
            <span className="di-wave-bar" />
            <span className="di-wave-bar" />
            <span className="di-wave-bar" />
            <span className="di-wave-bar" />
            <span className="di-wave-bar" />
        </span>
    );
}

// === Avatar (drag + long-hover popout) =====================================

export function Avatar({ event, onPopoutChange, size = "md" }: {
    event: IslandEvent;
    onPopoutChange?: (open: boolean) => void;
    size?: "sm" | "md";
}) {
    const [dragging, setDragging] = React.useState(false);
    const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const startHoverTimer = () => {
        if (!event.userId || !onPopoutChange) return;
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => onPopoutChange(true), 800);
    };

    const cancelHoverTimer = () => {
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    };

    React.useEffect(() => () => cancelHoverTimer(), []);

    const handleDragStart = (e: React.DragEvent) => {
        if (!event.userId) {
            e.preventDefault();
            return;
        }
        e.dataTransfer.setData("text/plain", `<@${event.userId}>`);
        e.dataTransfer.effectAllowed = "copy";
        setDragging(true);
        cancelHoverTimer();
        onPopoutChange?.(false);
    };
    const handleDragEnd = () => setDragging(false);
    const sizeClass = size === "sm" ? " di-icon-sm" : "";

    if (event.avatarUrl) {
        return (
            <img
                className={"di-icon di-avatar" + sizeClass + (dragging ? " di-avatar-dragging" : "")}
                src={event.avatarUrl}
                alt=""
                draggable={!!event.userId}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onMouseEnter={startHoverTimer}
                onMouseLeave={cancelHoverTimer}
            />
        );
    }
    return (
        <div className={"di-icon" + sizeClass} style={{ background: event.accent }}>
            {event.icon ?? "•"}
        </div>
    );
}

// === Avatar long-hover popout ==============================================

export function AvatarPopout({ event, onClose }: { event: IslandEvent; onClose: () => void; }) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    React.useEffect(() => {
        const handler = (e: MouseEvent) => {
            const path = e.composedPath();
            if (path.some(n => n === ref.current)) return;
            onClose();
        };
        document.addEventListener("mousedown", handler, { capture: true });
        return () => document.removeEventListener("mousedown", handler, { capture: true });
    }, [onClose]);

    if (!event.userId) return null;

    const user = UserStore.getUser(event.userId);
    let status = "offline";
    try { status = (PresenceStore.getStatus(event.userId) as string) || "offline"; } catch { }
    let customStatus = "";
    try {
        const acts = (PresenceStore.getActivities?.(event.userId) ?? []) as any[];
        const cs = acts.find(a => a.type === 4);
        customStatus = [cs?.emoji?.name, cs?.state].filter(Boolean).join(" ");
    } catch { }
    let bio = "";
    try { bio = (UserProfileStore.getUserProfile?.(event.userId) as any)?.bio ?? ""; } catch { }

    let mutualCount = 0;
    try {
        const guilds = GuildStore.getGuilds();
        for (const gid of Object.keys(guilds)) {
            if (GuildMemberStore.isMember?.(gid, event.userId)) mutualCount++;
        }
    } catch { }

    const displayName = (user as any)?.globalName || (user as any)?.global_name || user?.username || "Unknown";
    const handle = user?.username ? `@${user.username}` : "";
    const dotColor = STATUS_COLORS[status] ?? STATUS_COLORS.offline;

    return (
        <div ref={ref} className="di-popout" onMouseDown={e => e.stopPropagation()}>
            <div className="di-popout-banner" style={{ background: event.accent }} />
            <div className="di-popout-avatar-wrap">
                <img className="di-popout-avatar" src={event.avatarUrl} alt="" />
                <span className="di-popout-status-dot" style={{ background: dotColor }} />
            </div>
            <div className="di-popout-name">{displayName}</div>
            {handle && <div className="di-popout-handle">{handle}</div>}
            {customStatus && <div className="di-popout-cs">{customStatus}</div>}
            {bio && <div className="di-popout-bio">{bio.slice(0, 140)}{bio.length > 140 ? "…" : ""}</div>}
            <div className="di-popout-meta">
                <span className="di-popout-status-label" style={{ color: dotColor }}>
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                </span>
                {mutualCount > 0 && (
                    <span className="di-popout-mutual">{mutualCount} mutual server{mutualCount === 1 ? "" : "s"}</span>
                )}
            </div>
        </div>
    );
}

// === TypeBadge + QueueDots =================================================

export function TypeBadge({ event }: { event: IslandEvent; }) {
    const label = TYPE_LABELS[event.type];
    if (!label) return null;
    return <span className="di-badge" style={{ background: event.accent }}>{label}</span>;
}

export function QueueDots({ all, activeId }: { all: IslandEvent[]; activeId: string; }) {
    if (all.length <= 1) return null;
    return (
        <div className="di-queue-dot">
            {all.slice(0, 5).map(e => (
                <span key={e.id} className={e.id === activeId ? "di-active" : ""} />
            ))}
        </div>
    );
}

// === Right-click context menu ==============================================

export interface CtxItem {
    label: string;
    onClick: () => void;
    danger?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: {
    x: number;
    y: number;
    items: CtxItem[];
    onClose: () => void;
}) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    React.useEffect(() => {
        const handler = (e: MouseEvent) => {
            const path = e.composedPath();
            if (path.some(n => n === ref.current)) return;
            onClose();
        };
        document.addEventListener("mousedown", handler, { capture: true });
        return () => document.removeEventListener("mousedown", handler, { capture: true });
    }, [onClose]);

    return (
        <div
            ref={ref}
            className="di-ctx"
            style={{ left: x, top: y }}
            onMouseDown={e => e.stopPropagation()}
        >
            {items.map((it, i) => (
                <button
                    key={i}
                    className={"di-ctx-item" + (it.danger ? " di-ctx-danger" : "")}
                    onClick={ev => { ev.stopPropagation(); it.onClick(); onClose(); }}
                >
                    {it.label}
                </button>
            ))}
        </div>
    );
}
