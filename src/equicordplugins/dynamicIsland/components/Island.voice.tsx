/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import {
    FluxDispatcher,
    MediaEngineStore,
    React,
    useStateFromStores,
    UserStore,
    VoiceStateStore
} from "@webpack/common";

const MediaEngineActions = findByPropsLazy("setLocalVolume", "setLocalMute");

/**
 * Stream objects from ApplicationStreamingStore expose { guildId, channelId, ownerId }
 * but not streamKey — Discord builds the key on-demand. Format:
 *   guild:{guildId}:{channelId}:{userId}  for guild voice channels
 *   call:{channelId}:{userId}             for DM / group DM calls
 */
export function buildStreamKey(stream: any): string | null {
    if (!stream) return null;
    if (typeof stream === "string") return stream;
    if (typeof stream.streamKey === "string") return stream.streamKey;
    const owner = stream.ownerId;
    const channel = stream.channelId;
    if (!owner || !channel) return null;
    return stream.guildId
        ? `guild:${stream.guildId}:${channel}:${owner}`
        : `call:${channel}:${owner}`;
}

export function useSelfSpeaking(): boolean {
    const [speaking, setSpeaking] = React.useState(false);
    React.useEffect(() => {
        let myId: string | undefined;
        try { myId = UserStore.getCurrentUser()?.id; } catch { /* */ }
        if (!myId) return;
        const handler = (e: any) => {
            if (e.userId !== myId) return;
            setSpeaking(!!e.speakingFlags);
        };
        FluxDispatcher.subscribe("SPEAKING", handler);
        return () => { try { FluxDispatcher.unsubscribe("SPEAKING", handler); } catch { /* */ } };
    }, []);
    return speaking;
}

export function SelfAvatar({ speaking, size = "sm" }: { speaking: boolean; size?: "sm" | "md"; }) {
    const me = (() => { try { return UserStore.getCurrentUser(); } catch { return null; } })();
    const avatarUrl = (() => {
        try { return (me as any)?.getAvatarURL?.(undefined, 64, false); } catch { return undefined; }
    })();
    const sizeClass = size === "md" ? "" : " di-self-avatar-sm";
    if (!avatarUrl) {
        return (
            <div className={"di-self-avatar di-self-avatar-fallback" + sizeClass + (speaking ? " di-self-avatar-speaking" : "")}>
                {(me?.username?.[0] ?? "?").toUpperCase()}
            </div>
        );
    }
    return (
        <img
            className={"di-self-avatar" + sizeClass + (speaking ? " di-self-avatar-speaking" : "")}
            src={avatarUrl}
            alt=""
        />
    );
}

// === Watcher avatar stack ==================================================

export function AvatarStack({ userIds, max = 4 }: { userIds: string[]; max?: number; }) {
    if (userIds.length === 0) return null;
    const shown = userIds.slice(0, max);
    const overflow = Math.max(0, userIds.length - max);
    return (
        <div className="di-avatar-stack">
            {shown.map(id => {
                const u = UserStore.getUser(id) as any;
                const url = u?.getAvatarURL?.(undefined, 32, false);
                const title = u?.globalName || u?.global_name || u?.username || id;
                return url
                    ? <img key={id} className="di-avatar-stack-item" src={url} alt="" title={title} />
                    : <div key={id} className="di-avatar-stack-item di-avatar-stack-fallback" title={title}>{(u?.username?.[0] ?? "?").toUpperCase()}</div>;
            })}
            {overflow > 0 && <div className="di-avatar-stack-item di-avatar-stack-more">+{overflow}</div>}
        </div>
    );
}

// === Voice mixer popout ====================================================

function getLocalVolume(uid: string): number {
    try {
        if (MediaEngineStore.getLocalVolume) return MediaEngineStore.getLocalVolume(uid, "default") ?? 100;
    } catch { /* */ }
    return 100;
}

function setLocalVolume(uid: string, volume: number) {
    try {
        if (MediaEngineActions?.setLocalVolume) {
            MediaEngineActions.setLocalVolume(uid, volume, "default");
            return;
        }
    } catch { /* */ }
    try {
        FluxDispatcher.dispatch({
            type: "AUDIO_SET_LOCAL_VOLUME",
            userId: uid,
            volume,
            context: "default"
        });
    } catch { /* */ }
}

function VolumeRow({ userId }: { userId: string; }) {
    const user = UserStore.getUser(userId) as any;
    const initial = Math.round(getLocalVolume(userId));
    const [vol, setVol] = React.useState(initial);
    React.useEffect(() => { setVol(Math.round(getLocalVolume(userId))); }, [userId]);

    const url = user?.getAvatarURL?.(undefined, 32, false);
    const name = user?.globalName || user?.global_name || user?.username || userId;

    const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = parseInt(e.target.value, 10);
        setVol(v);
        setLocalVolume(userId, v);
    };

    const reset = (e: React.MouseEvent) => {
        e.preventDefault();
        setVol(100);
        setLocalVolume(userId, 100);
    };

    return (
        <div className="di-mix-row">
            {url
                ? <img className="di-mix-avatar" src={url} alt="" />
                : <div className="di-mix-avatar di-mix-avatar-fallback">{(user?.username?.[0] ?? "?").toUpperCase()}</div>}
            <div className="di-mix-name" title={name}>{name}</div>
            <input
                className="di-mix-slider"
                type="range"
                min="0"
                max="200"
                step="1"
                value={vol}
                onChange={onChange}
                onContextMenu={reset}
                title="Right-click to reset to 100%"
                style={{
                    accentColor: vol > 100 ? "#f0b232" : "#23a55a"
                }}
            />
            <span className="di-mix-pct">{Math.round(vol)}%</span>
        </div>
    );
}

export function VoiceMixer({ channelId, onClose }: { channelId: string; onClose: () => void; }) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => {
        const r = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
        return () => cancelAnimationFrame(r);
    }, []);

    React.useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [onClose]);

    const me = (() => { try { return UserStore.getCurrentUser(); } catch { return null; } })();
    const states = useStateFromStores([VoiceStateStore], () => {
        try { return VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}; } catch { return {} as any; }
    });
    const userIds = Object.keys(states).filter(id => id !== me?.id);

    return (
        <div ref={ref} className={"di-mixer" + (mounted ? " di-mixer-active" : "")} onMouseDown={e => e.stopPropagation()}>
            <div className="di-mixer-header">
                <span className="di-mixer-label">Mixer</span>
                <span className="di-mixer-count">{userIds.length} {userIds.length === 1 ? "user" : "users"}</span>
            </div>
            <div className="di-mixer-rows">
                {userIds.length === 0
                    ? <div className="di-mixer-empty">No one else in the channel</div>
                    : userIds.map(uid => <VolumeRow key={uid} userId={uid} />)}
            </div>
        </div>
    );
}
