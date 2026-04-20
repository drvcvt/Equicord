/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import {
    ChannelStore,
    NavigationRouter,
    React,
    ReadStateUtils
} from "@webpack/common";

import { openStalkerModal } from "../../userStalker/components/StalkerModal";
import { getTracked, removeTracked, setTrackedNotify } from "../../userStalker/store";
import settings from "../settings";
import { dismiss, pauseDismiss, resumeDismiss } from "../store";
import { IslandEvent } from "../types";
import {
    AvatarPopout,
    computeSegments,
    computeWidth,
    ContextMenu,
    CtxItem,
    SegmentData,
    TrackedSegment,
    useAnimatedSegments,
    useIslandState
} from "./Island.parts";
import { ReplyPill } from "./Island.reply";
import {
    DraftSegment,
    IdleSegment,
    StreamSegment,
    TransientExpandContent,
    TransientSegment,
    VoiceExpandContent,
    VoiceSegment
} from "./Island.segments";

const logger = new Logger("DynamicIsland", "#a78bfa");

export interface TransientHandlers {
    all: IslandEvent[];
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

function renderSegment(
    t: TrackedSegment,
    transientProps: TransientHandlers | null,
    onMouseEnter: () => void
): React.ReactNode {
    const d = t.data;
    if (d.type === "idle") return <IdleSegment />;
    if (!d.event) return null;

    switch (d.type) {
        case "voice_call":
            return <VoiceSegment event={d.event} expanded={false} onMouseEnter={onMouseEnter} />;
        case "stream":
            return <StreamSegment event={d.event} onMouseEnter={onMouseEnter} />;
        case "draft":
            return <DraftSegment event={d.event} onMouseEnter={onMouseEnter} />;
        case "transient":
            if (!transientProps) return null;
            return (
                <TransientSegment
                    event={d.event}
                    all={transientProps.all}
                    onMouseEnter={onMouseEnter}
                    onClick={transientProps.onClick}
                    onContextMenu={transientProps.onContextMenu}
                    onMouseDown={transientProps.onMouseDown}
                    onAuxClick={transientProps.onAuxClick}
                    onDragOver={transientProps.onDragOver}
                    onDragLeave={transientProps.onDragLeave}
                    onDrop={transientProps.onDrop}
                    dropTarget={transientProps.dropTarget}
                    onDismiss={transientProps.onDismiss}
                    onAck={transientProps.onAck}
                    onPopoutChange={transientProps.onPopoutChange}
                />
            );
    }
    return null;
}

function Surface({
    tracked,
    transientProps,
    expandedId,
    onExpandedChange
}: {
    tracked: TrackedSegment[];
    transientProps: TransientHandlers | null;
    expandedId: string | null;
    onExpandedChange: (id: string | null) => void;
}) {
    const width = computeWidth(tracked);
    const active = tracked.filter(t => t.status !== "out");
    const isIdleOnly = active.length === 1 && active[0].data.type === "idle";
    const expandedSeg = active.find(t => t.data.id === expandedId) ?? null;

    const activeIds = active.map(t => t.data.id).join("|");
    React.useEffect(() => {
        if (expandedId && !active.some(t => t.data.id === expandedId)) {
            onExpandedChange(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expandedId, activeIds]);

    const renderExpand = (seg: TrackedSegment): React.ReactNode => {
        const e = seg.data.event;
        if (!e) return null;
        if (seg.data.type === "voice_call") return <VoiceExpandContent event={e} />;
        if (seg.data.type === "transient") {
            if (!e.body) return null;
            return <TransientExpandContent event={e} />;
        }
        return null;
    };

    const expandNode = expandedSeg ? renderExpand(expandedSeg) : null;
    const expandOpen = !!expandNode;

    const surfaceClass = [
        "di-surface",
        isIdleOnly ? "di-surface-idle" : "",
        expandOpen ? "di-surface-expanded" : ""
    ].filter(Boolean).join(" ");

    return (
        <div
            className={surfaceClass}
            style={{ width: `${width}px` }}
            onMouseLeave={() => onExpandedChange(null)}
        >
            <div className="di-surface-row">
                {tracked.map((t, idx) => {
                    const prevActive = tracked.slice(0, idx).some(x => x.status !== "out");
                    const cls = "di-segment-wrap" +
                        (t.status === "out" ? " di-segment-leaving" : " di-segment-entering") +
                        (t.data.type === "voice_call" || t.data.type === "stream" ? " di-segment-wrap-left" : "") +
                        (t.data.type === "transient" ? " di-segment-wrap-right" : "");
                    return (
                        <React.Fragment key={t.data.id}>
                            {prevActive && t.status !== "out" && <div className="di-divider" />}
                            <div className={cls}>
                                {renderSegment(t, transientProps, () => onExpandedChange(t.data.id))}
                            </div>
                        </React.Fragment>
                    );
                })}
            </div>
            <div className="di-surface-expand">
                <div className="di-surface-expand-inner">{expandNode}</div>
            </div>
        </div>
    );
}

// === Main Island ===========================================================

export function Island() {
    const { active, all, live } = useIslandState();
    const [expandedId, setExpandedId] = React.useState<string | null>(null);
    const [replying, setReplying] = React.useState(false);
    const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number; } | null>(null);
    const [showPopout, setShowPopout] = React.useState(false);
    const [pendingFiles, setPendingFiles] = React.useState<File[] | null>(null);
    const [dropTarget, setDropTarget] = React.useState(false);
    const lastIdRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (active && active.id !== lastIdRef.current) {
            lastIdRef.current = active.id;
            setReplying(false);
            setCtxMenu(null);
            setShowPopout(false);
            setPendingFiles(null);
            setDropTarget(false);
        }
        if (!active) lastIdRef.current = null;
    }, [active?.id]);

    const segments: SegmentData[] = React.useMemo(
        () => computeSegments(live, active),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [live.map(e => e.id).join("|"), active?.id]
    );
    const tracked = useAnimatedSegments(segments);

    const cssVars: React.CSSProperties = {
        // @ts-expect-error css custom props
        "--di-top": `${settings.store.topOffset}px`,
        "--di-accent": active?.accent ?? "#5865f2"
    };

    const handleClick = (e: React.MouseEvent) => {
        if (!active) return;
        if ((e.target as HTMLElement).closest(".di-close, .di-ack, .di-avatar, .di-grab")) return;
        if (active.onClick) {
            active.onClick();
            dismiss(active.id);
        }
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if (!active) return;
        if (e.button !== 1) return;
        if (!active.replyTarget) return;
        e.preventDefault();
        e.stopPropagation();
        pauseDismiss(active.id);
        setReplying(true);
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!active?.replyTarget) return;
        const items = e.dataTransfer?.items;
        if (!items) return;
        const hasImage = Array.from(items).some(it => it.kind === "file" && it.type.startsWith("image/"));
        if (!hasImage) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropTarget) setDropTarget(true);
    };
    const handleDragLeave = (e: React.DragEvent) => {
        if (e.currentTarget === e.target) setDropTarget(false);
    };
    const handleDrop = (e: React.DragEvent) => {
        if (!active?.replyTarget) return;
        const fl = e.dataTransfer?.files;
        if (!fl || fl.length === 0) return;
        const imgs = Array.from(fl).filter(f => f.type.startsWith("image/"));
        if (imgs.length === 0) return;
        e.preventDefault();
        setDropTarget(false);
        pauseDismiss(active.id);
        setPendingFiles(imgs);
        setReplying(true);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        if (!active?.userId) return;
        e.preventDefault();
        e.stopPropagation();
        const rootEl = (e.currentTarget as HTMLElement).closest(".di-root") as HTMLElement | null;
        const r = rootEl?.getBoundingClientRect();
        setCtxMenu({
            x: e.clientX - (r?.left ?? 0),
            y: e.clientY - (r?.top ?? 0)
        });
    };

    const cancelReply = () => {
        if (!active) return;
        setReplying(false);
        resumeDismiss(active.id, settings.store.defaultDuration * 1000);
    };

    const sentReply = () => {
        if (!active) return;
        setReplying(false);
        dismiss(active.id);
    };

    const ackChannel = () => {
        if (!active?.channelId) return;
        try {
            const ch = ChannelStore.getChannel(active.channelId);
            if (ch) ReadStateUtils.ackChannel(ch);
        } catch (e) {
            logger.error("ack failed", e);
        }
        dismiss(active.id);
    };

    const buildCtxItems = (e: IslandEvent): CtxItem[] => {
        const items: CtxItem[] = [];
        if (e.channelId) {
            items.push({
                label: "Jump to channel",
                onClick: () => {
                    NavigationRouter.transitionTo(`/channels/${e.guildId ?? "@me"}/${e.channelId}`);
                    dismiss(e.id);
                }
            });
            items.push({ label: "Mark channel as read", onClick: ackChannel });
        }
        if (e.userId && getTracked()[e.userId]) {
            items.push({ label: "Open in Stalker", onClick: () => openStalkerModal(e.userId!) });
            const tr = getTracked()[e.userId];
            const muted = tr?.notify === false;
            items.push({
                label: muted ? "Unmute notifications" : "Mute notifications",
                onClick: () => setTrackedNotify(e.userId!, muted)
            });
            items.push({
                label: "Untrack user",
                danger: true,
                onClick: () => { removeTracked(e.userId!); dismiss(e.id); }
            });
        }
        items.push({ label: "Dismiss", onClick: () => dismiss(e.id) });
        return items;
    };

    const transientProps: TransientHandlers | null = active ? {
        all,
        onClick: handleClick,
        onContextMenu: handleContextMenu,
        onMouseDown: handleMouseDown,
        onAuxClick: ev => { if (ev.button === 1) ev.preventDefault(); },
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
        dropTarget,
        onDismiss: () => dismiss(active.id),
        onAck: ackChannel,
        onPopoutChange: setShowPopout
    } : null;

    return (
        <div className="di-root" style={cssVars}>
            <Surface
                tracked={tracked}
                transientProps={transientProps}
                expandedId={expandedId}
                onExpandedChange={setExpandedId}
            />
            {active && showPopout && active.userId && (
                <AvatarPopout event={active} onClose={() => setShowPopout(false)} />
            )}
            {active && replying && active.replyTarget && (
                <ReplyPill
                    event={active}
                    initialFiles={pendingFiles ?? undefined}
                    onSent={() => { setPendingFiles(null); sentReply(); }}
                    onCancel={() => { setPendingFiles(null); cancelReply(); }}
                />
            )}
            {active && ctxMenu && (
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    items={buildCtxItems(active)}
                    onClose={() => setCtxMenu(null)}
                />
            )}
        </div>
    );
}
