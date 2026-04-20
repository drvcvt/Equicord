/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type IslandEventType =
    | "mention"
    | "dm"
    | "reaction"
    | "call"
    | "voice_join"
    | "voice_leave"
    | "voice_move"
    | "stream_start"
    | "friend_online"
    | "friend_activity"
    | "soundboard"
    | "stalker"
    | "upload"
    | "rate_limit"
    | "custom";

// Higher number = higher priority. Critical preempts everything.
export const Priority = {
    Low: 1,
    Medium: 2,
    High: 3,
    Critical: 4
} as const;
export type PriorityLevel = typeof Priority[keyof typeof Priority];

export interface IslandEvent {
    id: string;
    type: IslandEventType;
    priority: PriorityLevel;
    title: string;
    subtitle?: string;
    /** small icon at left of compact view — emoji, single char, or image url */
    icon?: string;
    /** url to user avatar, displayed circular if set (overrides icon) */
    avatarUrl?: string;
    /** css color string for left accent bar */
    accent?: string;
    /** ms before auto-dismiss; 0 or undefined = sticky until manually dismissed */
    duration?: number;
    /** click handler on compact view (e.g. jump to channel, open profile) */
    onClick?: () => void;
    /** action buttons shown in expanded view */
    actions?: IslandAction[];
    /** extra body content for expanded view (plain text) */
    body?: string;
    /** if set, middle-click opens an inline reply input targeting this message */
    replyTarget?: {
        channelId: string;
        messageId: string;
    };
    /** Discord user id this event relates to — used by the right-click menu */
    userId?: string;
    /** Channel id this event happened in — for context menu (jump, mute) */
    channelId?: string;
    /** Guild id, if any */
    guildId?: string;
    /** When grouped, how many events have collapsed into this one (>=1) */
    count?: number;
    /**
     * Live activity: never auto-dismisses, ignored by getActive() (which selects
     * the transient pill), rendered in the dedicated live row above transient
     * notifications. Lifecycle is owned by the source that pushed it.
     */
    live?: boolean;
    /** Discriminator the live renderer dispatches on. */
    liveType?: "voice_call" | "stream" | "draft";
    createdAt: number;
}

export interface IslandAction {
    label: string;
    onClick: () => void;
    variant?: "primary" | "danger" | "default";
}
