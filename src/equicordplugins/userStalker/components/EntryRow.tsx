/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { closeAllModals } from "@utils/modal";
import { ChannelStore, GuildStore, NavigationRouter, UserStore } from "@webpack/common";

import { formatDuration, formatRelative } from "../stats";
import { AttachmentMeta, MessageEntry, MessageReplyMeta, StalkerEntry } from "../types";

function jumpToMessage(entry: StalkerEntry) {
    if (entry.type !== "message" && entry.type !== "message_edit" && entry.type !== "message_delete") return;
    const m = entry as MessageEntry;
    if (!m.channelId || !m.messageId) return;
    const guild = m.guildId ?? "@me";
    try {
        NavigationRouter.transitionTo(`/channels/${guild}/${m.channelId}/${m.messageId}`);
        closeAllModals();
    } catch { /* noop */ }
}

function isImage(a: AttachmentMeta): boolean {
    if (a.contentType?.startsWith("image/")) return true;
    return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(a.filename);
}

function isVideo(a: AttachmentMeta): boolean {
    if (a.contentType?.startsWith("video/")) return true;
    return /\.(mp4|webm|mov|mkv)$/i.test(a.filename);
}

function humanSize(bytes?: number): string {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentsBlock({ attachments }: { attachments: AttachmentMeta[]; }) {
    return (
        <div className="vc-stalker-attachments">
            {attachments.map((a, i) => {
                if (isImage(a)) {
                    return (
                        <a key={i} href={a.url} target="_blank" rel="noreferrer" className="vc-stalker-att-img">
                            <img
                                src={a.proxyUrl ?? a.url}
                                alt={a.filename}
                                loading="lazy"
                                onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                        </a>
                    );
                }
                if (isVideo(a)) {
                    return (
                        <video key={i} className="vc-stalker-att-video" controls preload="none" poster={a.proxyUrl}>
                            <source src={a.proxyUrl ?? a.url} type={a.contentType} />
                        </video>
                    );
                }
                return (
                    <a key={i} href={a.url} target="_blank" rel="noreferrer" className="vc-stalker-att-file">
                        📎 {a.filename} {humanSize(a.size) && <span>({humanSize(a.size)})</span>}
                        {a.localPath && <span className="vc-stalker-att-saved" title={`Saved to ${a.localPath}`}>· saved</span>}
                    </a>
                );
            })}
        </div>
    );
}

function channelName(id?: string | null): string {
    if (!id) return "—";
    const c = ChannelStore.getChannel(id);
    if (!c) return `#${id}`;
    return c.name ? `#${c.name}` : "DM";
}

function guildName(id?: string | null): string {
    if (!id) return "DM";
    return GuildStore.getGuild(id)?.name ?? id;
}

function describe(entry: StalkerEntry): { label: string; detail?: string; color: string; } {
    switch (entry.type) {
        case "message": {
            const atts = entry.attachments;
            const attCount = Array.isArray(atts) ? atts.length : (typeof atts === "number" ? atts : 0);
            return {
                label: `Sent message in ${channelName(entry.channelId)}`,
                detail: entry.content ? entry.content.slice(0, 400) : (attCount && !Array.isArray(atts) ? `[${attCount} attachment(s)]` : undefined),
                color: "#5865f2"
            };
        }
        case "message_edit":
            return {
                label: `Edited message in ${channelName(entry.channelId)}`,
                detail: entry.content?.slice(0, 400),
                color: "#faa61a"
            };
        case "message_delete":
            return { label: `Deleted message in ${channelName(entry.channelId)}`, color: "#ed4245" };
        case "voice_join":
            return {
                label: `Joined voice ${channelName(entry.channelId)}`,
                detail: entry.otherUserIds?.length
                    ? `with ${entry.otherUserIds.map(id => UserStore.getUser(id)?.username ?? id).join(", ")}`
                    : "(empty channel)",
                color: "#3ba55d"
            };
        case "voice_leave":
            return {
                label: `Left voice ${channelName(entry.channelId)}`,
                detail: entry.durationMs ? `after ${formatDuration(entry.durationMs)}` : undefined,
                color: "#ed4245"
            };
        case "voice_move":
            return {
                label: `Moved ${channelName(entry.oldChannelId)} → ${channelName(entry.newChannelId)}`,
                color: "#faa61a"
            };
        case "voice_mute":
            return { label: entry.enabled ? "Server muted" : "Server unmuted", color: "#72767d" };
        case "voice_deaf":
            return { label: entry.enabled ? "Server deafened" : "Server undeafened", color: "#72767d" };
        case "voice_video":
            return { label: entry.enabled ? "Turned camera on" : "Turned camera off", color: "#72767d" };
        case "voice_stream":
            return { label: entry.enabled ? "Started streaming" : "Stopped streaming", color: "#72767d" };
        case "voice_soundboard":
            return {
                label: "Played soundboard",
                detail: entry.emojiName ?? entry.soundId,
                color: "#faa61a"
            };
        case "presence":
            return { label: `Status: ${entry.status}`, color: "#b9bbbe" };
        case "activity_start":
            return { label: `Started activity: ${entry.activityName}`, color: "#5865f2" };
        case "activity_stop":
            return { label: `Stopped activity: ${entry.activityName}`, color: "#72767d" };
        case "profile_change": {
            const fieldLabel = {
                username: "username",
                globalName: "display name",
                avatar: "avatar",
                customStatus: "custom status"
            }[entry.field] ?? entry.field;
            if (entry.field === "avatar") {
                return { label: "Changed avatar", color: "#eb459e" };
            }
            return {
                label: `Changed ${fieldLabel}`,
                detail: `${entry.oldValue || "—"} → ${entry.newValue || "—"}`,
                color: "#eb459e"
            };
        }
    }
}

export function EntryRow({ entry }: { entry: StalkerEntry; }) {
    const { label, detail, color } = describe(entry);
    const ts = new Date(entry.timestamp);
    const isMsg = entry.type === "message" || entry.type === "message_edit" || entry.type === "message_delete";
    const msgAtts = (entry.type === "message" || entry.type === "message_edit")
        && Array.isArray((entry as MessageEntry).attachments)
        ? (entry as MessageEntry).attachments as AttachmentMeta[]
        : null;
    const reply = isMsg && typeof (entry as MessageEntry).replyTo === "object"
        ? (entry as MessageEntry).replyTo as MessageReplyMeta
        : null;
    return (
        <div className="vc-stalker-entry">
            <div className="vc-stalker-entry-bar" style={{ background: color }} />
            <div className="vc-stalker-entry-body">
                <div className="vc-stalker-entry-head">
                    {isMsg
                        ? (
                            <a
                                className="vc-stalker-entry-label vc-stalker-entry-label-link"
                                onClick={e => { e.preventDefault(); jumpToMessage(entry); }}
                                href="#"
                                title="Jump to message in Discord"
                            >
                                {label} ↗
                            </a>
                        )
                        : <span className="vc-stalker-entry-label">{label}</span>}
                    <span className="vc-stalker-entry-time" title={ts.toLocaleString()}>
                        {formatRelative(entry.timestamp)}
                    </span>
                </div>
                {reply && (
                    <div className="vc-stalker-entry-reply">
                        <span className="vc-stalker-entry-reply-arrow">↳ reply to</span>
                        <span className="vc-stalker-entry-reply-author">
                            {reply.authorName ?? (reply.authorId ? UserStore.getUser(reply.authorId)?.username ?? reply.authorId : "unknown")}
                        </span>
                        {reply.content && <span className="vc-stalker-entry-reply-content">{reply.content.slice(0, 120)}</span>}
                    </div>
                )}
                {detail && <div className="vc-stalker-entry-detail">{detail}</div>}
                {msgAtts && msgAtts.length > 0 && <AttachmentsBlock attachments={msgAtts} />}
                {entry.guildId && (
                    <div className="vc-stalker-entry-meta">{guildName(entry.guildId)}</div>
                )}
            </div>
        </div>
    );
}
