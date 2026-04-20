/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import {
    ChannelStore,
    CloudUploader,
    Constants,
    MessageActions,
    MessageStore,
    React,
    RestAPI,
    showToast,
    SnowflakeUtils,
    Toasts
} from "@webpack/common";

import { IslandEvent } from "../types";
import { GripIcon, SendIcon } from "./Island.parts";

const logger = new Logger("DynamicIsland", "#a78bfa");

async function uploadFile(file: File, channelId: string): Promise<{ filename: string; uploadedFilename: string; } | null> {
    return new Promise(resolve => {
        const upload = new CloudUploader({ file, platform: CloudUploadPlatform.WEB } as any, channelId);
        upload.on("complete", () => resolve({
            filename: (upload as any).filename,
            uploadedFilename: (upload as any).uploadedFilename
        }));
        upload.on("error", () => resolve(null));
        upload.upload();
    });
}

export async function sendReply(target: { channelId: string; messageId: string; }, content: string, files: File[]): Promise<boolean> {
    const channel = ChannelStore.getChannel(target.channelId);
    if (!channel) {
        showToast("Channel not loaded", Toasts.Type.FAILURE);
        return false;
    }

    if (files.length === 0) {
        const message = MessageStore.getMessage(target.channelId, target.messageId);
        try {
            const replyOptions = message
                ? MessageActions.getSendMessageOptionsForReply({
                    channel, message, shouldMention: true, showMentionToggle: false
                })
                : undefined;
            MessageActions._sendMessage(target.channelId, {
                content, tts: false, invalidEmojis: [], validNonShortcutEmojis: []
            }, replyOptions);
            return true;
        } catch (e) {
            logger.error("send failed", e);
            showToast("Reply failed", Toasts.Type.FAILURE);
            return false;
        }
    }

    try {
        const uploaded = await Promise.all(files.map(f => uploadFile(f, target.channelId)));
        const attachments = uploaded
            .filter((x): x is { filename: string; uploadedFilename: string; } => !!x)
            .map((u, i) => ({ id: String(i), filename: u.filename, uploaded_filename: u.uploadedFilename }));
        if (attachments.length === 0) {
            showToast("Image upload failed", Toasts.Type.FAILURE);
            return false;
        }
        await RestAPI.post({
            url: Constants.Endpoints.MESSAGES(target.channelId),
            body: {
                content,
                flags: 0,
                channel_id: target.channelId,
                nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
                attachments,
                message_reference: {
                    message_id: target.messageId,
                    channel_id: target.channelId
                }
            }
        });
        return true;
    } catch (e) {
        logger.error("attachment send failed", e);
        showToast("Reply failed", Toasts.Type.FAILURE);
        return false;
    }
}

export function buildShareText(e: IslandEvent): { plain: string; markdown: string; mention: string; } {
    const title = e.title ?? "";
    const subtitle = e.subtitle ? ` (${e.subtitle})` : "";
    const body = e.body ?? "";
    const plain = body ? `${title}${subtitle}: ${body}` : `${title}${subtitle}`;
    const markdown = body
        ? `> **${title}**${subtitle}\n> ${body.replace(/\n/g, "\n> ")}`
        : `**${title}**${subtitle}`;
    const mention = e.userId ? `<@${e.userId}> ` : "";
    return { plain, markdown, mention };
}

export function PillDragHandle({ event }: { event: IslandEvent; }) {
    const handleDragStart = (e: React.DragEvent) => {
        e.stopPropagation();
        const { plain, markdown, mention } = buildShareText(event);
        try {
            e.dataTransfer.setData("text/plain", `${mention}${markdown}`);
            e.dataTransfer.setData("text/markdown", markdown);
            e.dataTransfer.effectAllowed = "copy";
        } catch { /* */ }
        void plain;
    };
    return (
        <button
            className="di-grab"
            draggable
            onDragStart={handleDragStart}
            onClick={ev => ev.stopPropagation()}
            onMouseDown={ev => ev.stopPropagation()}
            aria-label="Drag content"
            title="Drag to share or paste into a chat"
        >
            <GripIcon />
        </button>
    );
}

// === Reply pill (textarea + send + image paste) ============================

export function ReplyPill({ event, initialFiles, onSent, onCancel }: {
    event: IslandEvent;
    initialFiles?: File[];
    onSent: () => void;
    onCancel: () => void;
}) {
    const [value, setValue] = React.useState("");
    const [sending, setSending] = React.useState(false);
    const [mounted, setMounted] = React.useState(false);
    const [files, setFiles] = React.useState<File[]>(() => initialFiles ?? []);
    const [previews, setPreviews] = React.useState<string[]>(
        () => (initialFiles ?? []).map(f => URL.createObjectURL(f))
    );
    const taRef = React.useRef<HTMLTextAreaElement | null>(null);
    const pillRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        const r1 = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
        const t = setTimeout(() => taRef.current?.focus(), 60);
        return () => { cancelAnimationFrame(r1); clearTimeout(t); };
    }, []);

    React.useEffect(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    }, [value]);

    React.useEffect(() => {
        const handler = (e: MouseEvent) => {
            const path = e.composedPath();
            if (path.some(n => n === pillRef.current)) return;
            onCancel();
        };
        document.addEventListener("mousedown", handler, { capture: true });
        return () => document.removeEventListener("mousedown", handler, { capture: true });
    }, [onCancel]);

    React.useEffect(() => () => { previews.forEach(URL.revokeObjectURL); }, []);

    const addFiles = (newFiles: File[]) => {
        if (newFiles.length === 0) return;
        const newPreviews = newFiles.map(f => URL.createObjectURL(f));
        setFiles(prev => [...prev, ...newFiles]);
        setPreviews(prev => [...prev, ...newPreviews]);
    };

    const removeFile = (idx: number) => {
        setFiles(prev => prev.filter((_, i) => i !== idx));
        setPreviews(prev => {
            const url = prev[idx];
            if (url) URL.revokeObjectURL(url);
            return prev.filter((_, i) => i !== idx);
        });
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const items = Array.from(e.clipboardData?.items ?? []);
        const imgs: File[] = [];
        for (const it of items) {
            if (it.type.startsWith("image/")) {
                const f = it.getAsFile();
                if (f) imgs.push(f);
            }
        }
        if (imgs.length > 0) {
            e.preventDefault();
            addFiles(imgs);
        }
    };

    const submit = async () => {
        const text = value.trim();
        if ((!text && files.length === 0) || sending || !event.replyTarget) return;
        setSending(true);
        const ok = await sendReply(event.replyTarget, text, files);
        if (ok) setTimeout(onSent, 100);
        else setSending(false);
    };

    const eat = (e: React.SyntheticEvent) => {
        e.stopPropagation();
        (e.nativeEvent as Event).stopImmediatePropagation?.();
    };

    const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
        const next = e.relatedTarget as HTMLElement | null;
        if (next && next.closest && next.closest(".di-reply-pill")) return;
        setTimeout(() => taRef.current?.focus(), 0);
    };

    const canSend = (value.trim().length > 0 || files.length > 0) && !sending;

    return (
        <div
            ref={pillRef}
            className={"di-reply-pill" + (mounted ? " di-reply-active" : "")}
            onMouseDown={e => e.stopPropagation()}
        >
            {previews.length > 0 && (
                <div className="di-reply-thumbs">
                    {previews.map((url, i) => {
                        const file = files[i];
                        const onThumbDragStart = (e: React.DragEvent) => {
                            if (!file) return;
                            try {
                                e.dataTransfer.effectAllowed = "copy";
                                e.dataTransfer.items.add(file);
                                e.dataTransfer.setData("text/uri-list", url);
                                e.dataTransfer.setData("DownloadURL", `image/${file.type.split("/")[1] || "png"}:${file.name}:${url}`);
                            } catch { /* */ }
                        };
                        return (
                            <div className="di-reply-thumb" key={url} draggable onDragStart={onThumbDragStart} title="Drag to share">
                                <img src={url} alt="" />
                                <button
                                    className="di-reply-thumb-x"
                                    onClick={ev => { ev.stopPropagation(); removeFile(i); }}
                                    aria-label="Remove attachment"
                                >×</button>
                            </div>
                        );
                    })}
                </div>
            )}
            <div className="di-reply-row">
                <textarea
                    ref={taRef}
                    className="di-reply-input"
                    placeholder={`Reply to ${event.title}…`}
                    value={value}
                    disabled={sending}
                    rows={1}
                    autoFocus
                    onChange={e => { eat(e); setValue(e.target.value); }}
                    onKeyDown={e => {
                        eat(e);
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            submit();
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            onCancel();
                        }
                    }}
                    onKeyUp={eat}
                    onKeyPress={eat}
                    onPaste={handlePaste}
                    onBlur={handleBlur}
                    onClick={e => e.stopPropagation()}
                />
                <button
                    className={"di-reply-send" + (canSend ? " di-reply-send-ready" : "")}
                    disabled={!canSend}
                    onClick={ev => { ev.stopPropagation(); submit(); }}
                    onMouseDown={ev => ev.stopPropagation()}
                    aria-label="Send reply"
                    title="Send (Enter)"
                >
                    <SendIcon />
                </button>
            </div>
        </div>
    );
}
