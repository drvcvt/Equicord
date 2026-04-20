/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openPrivateChannel } from "@utils/discord";
import { Logger } from "@utils/Logger";
import {
    ChannelActions,
    ChannelStore,
    GuildStore,
    MessageActions,
    MessageStore,
    NavigationRouter,
    PresenceStore,
    React,
    ReadStateStore,
    RelationshipStore,
    useStateFromStores,
    UserStore,
    VoiceStateStore
} from "@webpack/common";

import settings from "../settings";

const logger = new Logger("DynamicIsland.hub", "#a78bfa");

type HubTab = "voice" | "messages" | "online";
const TABS: { id: HubTab; label: string; }[] = [
    { id: "voice", label: "Voice" },
    { id: "messages", label: "Messages" },
    { id: "online", label: "Online" }
];

const STATUS_COLORS: Record<string, string> = {
    online: "#23a55a",
    idle: "#f0b232",
    dnd: "#f23f43",
    streaming: "#593695",
    offline: "#80848e"
};

// === Voice presence helpers ================================================

function useInVoiceMap(): Map<string, string> {
    return useStateFromStores([VoiceStateStore], () => {
        const map = new Map<string, string>();
        const all = (VoiceStateStore as any).getAllVoiceStates?.() ?? {};
        const consider = (uid: string, s: any) => {
            if (!s || typeof s !== "object") return;
            if (s.channelId) map.set(uid, s.channelId);
        };
        for (const k of Object.keys(all)) {
            const v = all[k];
            if (v && typeof v === "object" && typeof v.channelId !== "undefined") consider(k, v);
            else if (v && typeof v === "object") for (const uid of Object.keys(v)) consider(uid, v[uid]);
        }
        return map;
    });
}

// === Count hooks (for tab labels) ==========================================

function useFriendCallCount(): number {
    return useStateFromStores([VoiceStateStore, RelationshipStore], () => {
        let me: string | undefined;
        try { me = UserStore.getCurrentUser()?.id; } catch { /* */ }
        const isFriend = (uid: string) => {
            try { return RelationshipStore.isFriend(uid); } catch { return false; }
        };
        const channels = new Set<string>();
        const all = (VoiceStateStore as any).getAllVoiceStates?.() ?? {};
        const consider = (uid: string, s: any) => {
            if (!s || typeof s !== "object") return;
            if (!s.channelId || uid === me) return;
            if (!isFriend(uid)) return;
            channels.add(s.channelId);
        };
        for (const k of Object.keys(all)) {
            const v = all[k];
            if (v && typeof v === "object" && typeof v.channelId !== "undefined") consider(k, v);
            else if (v && typeof v === "object") for (const uid of Object.keys(v)) consider(uid, v[uid]);
        }
        return channels.size;
    });
}

function channelHasUnread(channelId: string, lastMessageId?: string | null): boolean {
    if (!lastMessageId) return false;
    try {
        const count = (ReadStateStore as any).getUnreadCount?.(channelId);
        if (typeof count === "number") return count > 0;
    } catch { /* */ }
    // Fallback if getUnreadCount isn't available in this build.
    try { return !!ReadStateStore.hasUnread(channelId); } catch { return false; }
}

function useUnreadDMCount(): number {
    return useStateFromStores([ChannelStore, ReadStateStore, RelationshipStore], () => {
        let me: string | undefined;
        try { me = UserStore.getCurrentUser()?.id; } catch { /* */ }
        const dms: any[] = (ChannelStore as any).getSortedPrivateChannels?.() ?? [];
        let n = 0;
        for (const ch of dms) {
            if (ch.type !== 1) continue;
            const recips: any[] = ch.recipients ?? [];
            const rid: string | undefined = typeof recips[0] === "string" ? recips[0] : recips[0]?.id ?? ch.getRecipientId?.();
            if (!rid || rid === me) continue;
            try { if (!RelationshipStore.isFriend(rid)) continue; } catch { continue; }
            if (channelHasUnread(ch.id, ch.lastMessageId)) n++;
        }
        return n;
    });
}

function useOnlineFriendCount(): number {
    return useStateFromStores([RelationshipStore, PresenceStore], () => {
        const ids: string[] = (RelationshipStore as any).getFriendIDs?.() ?? [];
        let n = 0;
        for (const id of ids) {
            let status = "offline";
            try { status = (PresenceStore.getStatus(id) as string) || "offline"; } catch { /* */ }
            if (status !== "offline" && status !== "invisible") n++;
        }
        return n;
    });
}

function VoiceDot({ channelId }: { channelId: string; }) {
    const ch = ChannelStore.getChannel(channelId);
    const label = ch?.name ? `In voice — #${ch.name}` : "In a voice call";
    return (
        <span className="di-hub-voice-dot" title={label} aria-label={label}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" fill="currentColor" />
                <path d="M6 11a6 6 0 0 0 12 0M12 17v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
        </span>
    );
}

// === Voice tab =============================================================

interface ActiveCall {
    channelId: string;
    guildId: string | null;
    userIds: string[];
}

function useFriendCalls(): ActiveCall[] {
    return useStateFromStores([VoiceStateStore, RelationshipStore], () => {
        let me: string | undefined;
        try { me = UserStore.getCurrentUser()?.id; } catch { /* */ }
        const isFriend = (uid: string) => {
            try { return RelationshipStore.isFriend(uid); } catch { return false; }
        };
        const byChannel = new Map<string, ActiveCall>();
        const all = (VoiceStateStore as any).getAllVoiceStates?.() ?? {};
        const consider = (uid: string, s: any) => {
            if (!s || typeof s !== "object") return;
            const chId: string | undefined = s.channelId;
            if (!chId || uid === me) return;
            if (!isFriend(uid)) return;
            let entry = byChannel.get(chId);
            if (!entry) {
                entry = { channelId: chId, guildId: s.guildId ?? null, userIds: [] };
                byChannel.set(chId, entry);
            }
            if (!entry.userIds.includes(uid)) entry.userIds.push(uid);
        };
        for (const k of Object.keys(all)) {
            const v = all[k];
            if (v && typeof v === "object" && typeof v.channelId !== "undefined") consider(k, v);
            else if (v && typeof v === "object") for (const uid of Object.keys(v)) consider(uid, v[uid]);
        }
        return [...byChannel.values()]
            .filter(c => c.userIds.length > 0)
            .sort((a, b) => b.userIds.length - a.userIds.length)
            .slice(0, 10);
    });
}

function VoiceCallRow({ call, onClose }: { call: ActiveCall; onClose: () => void; }) {
    const [confirming, setConfirming] = React.useState(false);
    const ch = ChannelStore.getChannel(call.channelId);
    const guild = call.guildId ? GuildStore.getGuild(call.guildId) : null;
    const name = ch?.name ? `#${ch.name}` : (ch?.type === 3 ? (ch.name || "Group DM") : "Voice");
    const sub = guild?.name ?? (ch?.type === 1 ? "DM" : ch?.type === 3 ? "Group" : "Voice");
    const shown = call.userIds.slice(0, 4);
    const overflow = Math.max(0, call.userIds.length - shown.length);

    const join = () => {
        try {
            if (call.guildId) {
                ChannelActions.selectVoiceChannel(call.channelId);
            } else {
                NavigationRouter.transitionTo(`/channels/@me/${call.channelId}`);
                ChannelActions.selectVoiceChannel(call.channelId);
            }
        } catch (e) {
            logger.error("join failed", e);
        }
        onClose();
    };

    return (
        <div className={"di-hub-row di-hub-row-voice" + (confirming ? " di-hub-row-confirming" : "")}>
            <div className="di-hub-row-text">
                <span className="di-hub-row-title">{name}</span>
                <span className="di-hub-row-sub">{sub}</span>
            </div>
            <div className="di-hub-avatars">
                {shown.map(uid => {
                    const u = UserStore.getUser(uid) as any;
                    const url = u?.getAvatarURL?.(undefined, 32, false);
                    const letter = (u?.username?.[0] ?? "?").toUpperCase();
                    const title = u?.globalName || u?.global_name || u?.username || uid;
                    return url
                        ? <img key={uid} className="di-hub-avatar-stack" src={url} alt="" title={title} />
                        : <div key={uid} className="di-hub-avatar-stack di-hub-avatar-fallback" title={title}>{letter}</div>;
                })}
                {overflow > 0 && <div className="di-hub-avatar-stack di-hub-avatar-more">+{overflow}</div>}
            </div>
            {!confirming ? (
                <button className="di-hub-action di-hub-action-go" onClick={() => setConfirming(true)}>Join</button>
            ) : (
                <div className="di-hub-confirm-group">
                    <button className="di-hub-confirm-yes" onClick={join}>Yes</button>
                    <button className="di-hub-confirm-no" onClick={() => setConfirming(false)}>Cancel</button>
                </div>
            )}
        </div>
    );
}

function VoiceTab({ onClose }: { onClose: () => void; }) {
    const calls = useFriendCalls();
    if (calls.length === 0) return (
        <div className="di-hub-empty">
            <svg className="di-hub-empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" fill="currentColor" opacity="0.55" />
                <path d="M6 11a6 6 0 0 0 12 0M12 17v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>No friends in voice</span>
        </div>
    );
    return (
        <div className="di-hub-list">
            {calls.map(c => <VoiceCallRow key={c.channelId} call={c} onClose={onClose} />)}
        </div>
    );
}

// === Messages tab ==========================================================

interface DMItem {
    channelId: string;
    user: any;
    lastMsg: any;
}

function useFriendDMs(limit = 12): DMItem[] {
    return useStateFromStores([ChannelStore, MessageStore, RelationshipStore], () => {
        let me: string | undefined;
        try { me = UserStore.getCurrentUser()?.id; } catch { /* */ }
        const isFriend = (uid: string) => {
            try { return RelationshipStore.isFriend(uid); } catch { return false; }
        };
        const dms: any[] = (ChannelStore as any).getSortedPrivateChannels?.() ?? [];
        const results: DMItem[] = [];
        for (const ch of dms) {
            if (ch.type !== 1) continue;
            const recips: any[] = ch.recipients ?? [];
            const recipId: string | undefined = typeof recips[0] === "string" ? recips[0] : recips[0]?.id ?? ch.getRecipientId?.();
            if (!recipId || recipId === me) continue;
            if (!isFriend(recipId)) continue;
            const user = UserStore.getUser(recipId);
            if (!user) continue;
            let lastMsg: any = null;
            try {
                const msgs: any = MessageStore.getMessages(ch.id);
                const arr: any[] = msgs?.toArray?.() ?? msgs?._array ?? [];
                lastMsg = arr[arr.length - 1] ?? null;
            } catch { /* */ }
            results.push({ channelId: ch.id, user, lastMsg });
            if (results.length >= limit) break;
        }
        return results;
    });
}

function timeAgo(ts: number | string | undefined | null): string {
    if (!ts) return "";
    const t = typeof ts === "number" ? ts : new Date(ts as any).getTime();
    if (!t || Number.isNaN(t)) return "";
    const s = (Date.now() - t) / 1000;
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 604800) return `${Math.floor(s / 86400)}d`;
    return `${Math.floor(s / 604800)}w`;
}

function DMRow({ item, onClose, inVoiceChannelId, pending }: { item: DMItem; onClose: () => void; inVoiceChannelId?: string; pending?: boolean; }) {
    const user = item.user as any;
    const name = user?.globalName || user?.global_name || user?.username || "?";
    const url = user?.getAvatarURL?.(undefined, 48, false);
    const letter = (user?.username?.[0] ?? "?").toUpperCase();
    let status = "offline";
    try { status = (PresenceStore.getStatus(user?.id) as string) || "offline"; } catch { /* */ }

    let mentions = 0;
    try { mentions = ReadStateStore.getMentionCount(item.channelId) ?? 0; } catch { /* */ }
    const ch: any = ChannelStore.getChannel(item.channelId);
    const unread = channelHasUnread(item.channelId, ch?.lastMessageId);

    const content: string = (() => {
        const m = item.lastMsg;
        if (!m) return "";
        const c = (m.content ?? "").trim();
        if (c) return c;
        if (m.attachments?.length) return "[attachment]";
        if (m.sticker_items?.length || m.stickerItems?.length) return "[sticker]";
        if (m.embeds?.length) return "[embed]";
        return "";
    })();

    const ts = item.lastMsg?.timestamp;
    let me: string | undefined;
    try { me = UserStore.getCurrentUser()?.id; } catch { /* */ }
    const mine = item.lastMsg?.author?.id === me;
    const snippet = content ? `${mine ? "You: " : ""}${content}` : "";

    const open = () => {
        try { NavigationRouter.transitionTo(`/channels/@me/${item.channelId}`); } catch (e) { logger.error("navigate DM", e); }
        onClose();
    };

    return (
        <button className={"di-hub-row di-hub-row-button" + (unread ? " di-hub-row-unread" : "")} onClick={open}>
            <div className="di-hub-avatar-wrap">
                {url
                    ? <img className="di-hub-avatar" src={url} alt="" />
                    : <div className="di-hub-avatar di-hub-avatar-fallback">{letter}</div>}
                <span className="di-hub-status-dot" style={{ backgroundColor: STATUS_COLORS[status] ?? STATUS_COLORS.offline }} />
            </div>
            <div className="di-hub-row-text">
                <div className="di-hub-row-title-row">
                    <span className="di-hub-row-title">{name}</span>
                    {inVoiceChannelId && <VoiceDot channelId={inVoiceChannelId} />}
                </div>
                {snippet
                    ? <span className="di-hub-row-snippet">{snippet}</span>
                    : pending && <span className="di-hub-skeleton di-hub-skeleton-snippet" aria-hidden />}
            </div>
            <div className="di-hub-row-meta">
                {mentions > 0
                    ? <span className="di-hub-mention">{mentions > 9 ? "9+" : mentions}</span>
                    : unread && <span className="di-hub-unread-dot" aria-label="Unread" />}
                {ts && <span className="di-hub-row-time">{timeAgo(ts)}</span>}
            </div>
        </button>
    );
}

function MessagesTab({ onClose }: { onClose: () => void; }) {
    const items = useFriendDMs();
    const inVoice = useInVoiceMap();
    const [settled, setSettled] = React.useState(false);

    // Eagerly fetch the last message for DMs that haven't had messages loaded
    // in this session. Without this, snippets only appear once the user has
    // actually visited the chat. Limit: 8 concurrent to avoid request storms.
    const channelsKey = items.map(i => i.channelId).join("|");
    React.useEffect(() => {
        const missing = items.filter(i => !i.lastMsg).slice(0, 8);
        for (const m of missing) {
            try {
                const has = (MessageStore as any).hasPresent?.(m.channelId);
                if (has) continue;
                MessageActions.fetchMessages({ channelId: m.channelId, limit: 1 });
            } catch (e) { logger.error("prefetch DM", e); }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelsKey]);

    // Hide skeleton shimmers after the fetch window; if the fetch succeeded the
    // snippet already replaced it, if it didn't there's really nothing to show.
    React.useEffect(() => {
        const t = setTimeout(() => setSettled(true), 900);
        return () => clearTimeout(t);
    }, []);

    if (items.length === 0) return (
        <div className="di-hub-empty">
            <svg className="di-hub-empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"
                    stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill="currentColor" fillOpacity="0.18" />
            </svg>
            <span>No recent DMs</span>
        </div>
    );
    return (
        <div className="di-hub-list">
            {items.map(i => (
                <DMRow
                    key={i.channelId}
                    item={i}
                    onClose={onClose}
                    inVoiceChannelId={inVoice.get(i.user?.id)}
                    pending={!i.lastMsg && !settled}
                />
            ))}
        </div>
    );
}

// === Online tab ============================================================

interface OnlineFriend {
    id: string;
    user: any;
    status: string;
    activity?: any;
}

function useOnlineFriends(): OnlineFriend[] {
    return useStateFromStores([RelationshipStore, PresenceStore, UserStore], () => {
        const ids: string[] = (RelationshipStore as any).getFriendIDs?.() ?? [];
        const order: Record<string, number> = { online: 0, idle: 1, dnd: 2 };
        const out: OnlineFriend[] = [];
        for (const id of ids) {
            let status = "offline";
            try { status = (PresenceStore.getStatus(id) as string) || "offline"; } catch { /* */ }
            if (status === "offline" || status === "invisible") continue;
            const user = UserStore.getUser(id);
            if (!user) continue;
            let activity: any;
            try {
                const acts: any[] = (PresenceStore as any).getActivities?.(id) ?? [];
                activity = acts.find(a => a.type === 0 || a.type === 2 || a.type === 3) ?? acts.find(a => a.type === 4);
            } catch { /* */ }
            out.push({ id, user, status, activity });
        }
        return out.sort((a, b) => {
            const oa = order[a.status] ?? 99;
            const ob = order[b.status] ?? 99;
            if (oa !== ob) return oa - ob;
            const na = (a.user?.globalName || a.user?.username || "").toLowerCase();
            const nb = (b.user?.globalName || b.user?.username || "").toLowerCase();
            return na.localeCompare(nb);
        });
    });
}

function OnlineRow({ friend, onClose, inVoiceChannelId }: { friend: OnlineFriend; onClose: () => void; inVoiceChannelId?: string; }) {
    const user = friend.user as any;
    const name = user?.globalName || user?.global_name || user?.username || "?";
    const url = user?.getAvatarURL?.(undefined, 48, false);
    const letter = (user?.username?.[0] ?? "?").toUpperCase();

    const activityText = (() => {
        const a = friend.activity;
        if (!a) return "";
        if (a.type === 4) {
            const emoji = a.emoji?.name ? `${a.emoji.name} ` : "";
            return `${emoji}${a.state ?? ""}`.trim();
        }
        if (a.type === 2) return `♪ ${a.details ?? a.name ?? ""}`.trim();
        return a.name ?? "";
    })();

    const open = () => {
        try { openPrivateChannel(friend.id); } catch (e) { logger.error("open DM", e); }
        onClose();
    };

    return (
        <button className="di-hub-row di-hub-row-button" onClick={open} title={`Open DM with ${name}`}>
            <div className="di-hub-avatar-wrap">
                {url
                    ? <img className="di-hub-avatar" src={url} alt="" />
                    : <div className="di-hub-avatar di-hub-avatar-fallback">{letter}</div>}
                <span className="di-hub-status-dot" style={{ background: STATUS_COLORS[friend.status] ?? STATUS_COLORS.offline }} />
            </div>
            <div className="di-hub-row-text">
                <div className="di-hub-row-title-row">
                    <span className="di-hub-row-title">{name}</span>
                    {inVoiceChannelId && <VoiceDot channelId={inVoiceChannelId} />}
                </div>
                {activityText && <span className="di-hub-row-snippet">{activityText}</span>}
            </div>
        </button>
    );
}

function OnlineTab({ onClose }: { onClose: () => void; }) {
    const friends = useOnlineFriends();
    const inVoice = useInVoiceMap();
    if (friends.length === 0) return (
        <div className="di-hub-empty">
            <svg className="di-hub-empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" fill="currentColor" fillOpacity="0.18" />
                <path d="M4 21a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span>No friends online</span>
        </div>
    );
    return (
        <div className="di-hub-list">
            {friends.map(f => (
                <OnlineRow
                    key={f.id}
                    friend={f}
                    onClose={onClose}
                    inVoiceChannelId={inVoice.get(f.id)}
                />
            ))}
        </div>
    );
}

// === Hub panel =============================================================

export function HubPanel({ active, onClose, initialTab = "voice" }: {
    active: boolean;
    onClose: () => void;
    initialTab?: HubTab;
}) {
    const [tab, setTab] = React.useState<HubTab>(initialTab);
    const ref = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        const handler = (e: MouseEvent) => {
            const path = e.composedPath();
            if (path.some(n => n === ref.current)) return;
            // Clicks on the island itself are handled elsewhere (to allow toggling).
            if (path.some(n => (n as HTMLElement)?.classList?.contains?.("di-segment-idle"))) return;
            if (path.some(n => (n as HTMLElement)?.classList?.contains?.("di-surface"))) return;
            onClose();
        };
        document.addEventListener("mousedown", handler, { capture: true });
        return () => document.removeEventListener("mousedown", handler, { capture: true });
    }, [onClose]);

    const tabIdx = Math.max(0, TABS.findIndex(t => t.id === tab));

    const voiceCount = useFriendCallCount();
    const unreadCount = useUnreadDMCount();
    const onlineCount = useOnlineFriendCount();
    const counts: Record<HubTab, number> = {
        voice: voiceCount,
        messages: unreadCount,
        online: onlineCount
    };

    const s = settings.use(["hubDensity", "hubAccent", "hubWidth", "hubFont"]);
    const density = s.hubDensity ?? "cozy";
    const accent = (s.hubAccent || "").trim() || "#a892ff";
    const font = (s.hubFont || "").trim();

    const hubStyle: React.CSSProperties = {
        // @ts-expect-error css custom props
        "--di-hub-accent": accent,
        "--di-hub-width": typeof s.hubWidth === "number" ? `${s.hubWidth}px` : undefined,
        ...(font ? { "--di-hub-font": font } as any : {})
    };

    return (
        <div
            ref={ref}
            className={"di-hub di-hub-density-" + density + (active ? " di-hub-active" : "")}
            style={hubStyle}
            onMouseDown={e => e.stopPropagation()}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
        >
            <div className="di-hub-tabs">
                {TABS.map(t => {
                    const c = counts[t.id];
                    const isMentions = t.id === "messages" && c > 0;
                    return (
                        <button
                            key={t.id}
                            className={"di-hub-tab" + (t.id === tab ? " di-hub-tab-active" : "")}
                            onClick={() => setTab(t.id)}
                        >
                            <span className="di-hub-tab-label">{t.label}</span>
                            {c > 0 && (
                                <span className={"di-hub-tab-count" + (isMentions ? " di-hub-tab-count-alert" : "")}>
                                    {c > 99 ? "99+" : c}
                                </span>
                            )}
                        </button>
                    );
                })}
                <span
                    className="di-hub-tab-indicator"
                    style={{ transform: `translate3d(${tabIdx * 100}%, 0, 0)` }}
                />
            </div>
            <div className="di-hub-body">
                <div key={tab} className="di-hub-pane">
                    {tab === "voice" && <VoiceTab onClose={onClose} />}
                    {tab === "messages" && <MessagesTab onClose={onClose} />}
                    {tab === "online" && <OnlineTab onClose={onClose} />}
                </div>
            </div>
        </div>
    );
}
