/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type StalkerEntryType =
    | "message"
    | "message_edit"
    | "message_delete"
    | "voice_join"
    | "voice_leave"
    | "voice_move"
    | "voice_mute"
    | "voice_deaf"
    | "voice_video"
    | "voice_stream"
    | "voice_soundboard"
    | "presence"
    | "activity_start"
    | "activity_stop"
    | "profile_change";

export interface StalkerEntryBase {
    type: StalkerEntryType;
    userId: string;
    timestamp: number;
    guildId?: string | null;
    channelId?: string | null;
}

export interface AttachmentMeta {
    url: string;
    proxyUrl?: string;
    filename: string;
    contentType?: string;
    width?: number;
    height?: number;
    size?: number;
    /** Filled in after background download completes. */
    localPath?: string;
}

export interface MessageEntry extends StalkerEntryBase {
    type: "message" | "message_edit" | "message_delete";
    messageId: string;
    content?: string;
    /** new format: array of attachment metadata. Old logs stored just a count (number). */
    attachments?: AttachmentMeta[] | number;
    stickers?: number;
    mentions?: string[];
    /** new format: reply metadata object. Old logs stored just the message id (string). */
    replyTo?: MessageReplyMeta | string;
}

export interface VoiceJoinEntry extends StalkerEntryBase {
    type: "voice_join";
    otherUserIds?: string[];
}

export interface VoiceLeaveEntry extends StalkerEntryBase {
    type: "voice_leave";
    durationMs?: number;
}

export interface VoiceMoveEntry extends StalkerEntryBase {
    type: "voice_move";
    oldChannelId: string;
    newChannelId: string;
}

export interface VoiceFlagEntry extends StalkerEntryBase {
    type: "voice_mute" | "voice_deaf" | "voice_video" | "voice_stream";
    enabled: boolean;
}

export interface SoundboardEntry extends StalkerEntryBase {
    type: "voice_soundboard";
    soundId?: string;
    emojiName?: string;
}

export interface PresenceEntry extends StalkerEntryBase {
    type: "presence";
    status: "online" | "idle" | "dnd" | "offline" | "invisible";
}

export interface ActivityEntry extends StalkerEntryBase {
    type: "activity_start" | "activity_stop";
    activityName: string;
    applicationId?: string;
}

export type ProfileField = "username" | "globalName" | "avatar" | "customStatus";

export interface ProfileChangeEntry extends StalkerEntryBase {
    type: "profile_change";
    field: ProfileField;
    oldValue?: string | null;
    newValue?: string | null;
}

export interface MessageReplyMeta {
    messageId: string;
    authorId?: string;
    authorName?: string;
    content?: string;
}

export type StalkerEntry =
    | MessageEntry
    | VoiceJoinEntry
    | VoiceLeaveEntry
    | VoiceMoveEntry
    | VoiceFlagEntry
    | SoundboardEntry
    | PresenceEntry
    | ActivityEntry
    | ProfileChangeEntry;

export interface TrackedUser {
    id: string;
    username?: string;
    addedAt: number;
    notify?: boolean;
}

export interface TrackedMap {
    [userId: string]: TrackedUser;
}
