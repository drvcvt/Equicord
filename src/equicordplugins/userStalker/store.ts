/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

import { StalkerEntry, TrackedMap, TrackedUser } from "./types";

type NativeHelpers = PluginNative<typeof import("./native")>;

function getNative(): NativeHelpers | null {
    if (!IS_DISCORD_DESKTOP && !IS_EQUIBOP && !IS_VESKTOP) return null;
    const helpers = (globalThis as any).VencordNative?.pluginHelpers?.UserStalker as NativeHelpers | undefined;
    return helpers ?? null;
}

const logger = new Logger("UserStalker", "#ff69b4");
let warnedNoNative = false;

function warnNoNative() {
    if (warnedNoNative) return;
    warnedNoNative = true;
    logger.error("Native module unavailable — data will NOT persist to disk. Fully quit and restart Discord.");
    try {
        showToast("UserStalker: disk persistence disabled. Restart Discord fully.", Toasts.Type.FAILURE, { duration: 8000 } as any);
    } catch { /* toast might not be ready */ }
}

const logs = new Map<string, StalkerEntry[]>();
const tracked: TrackedMap = {};

export interface LiveVoiceSession {
    channelId: string;
    guildId?: string | null;
    joinedAt: number;
}
const liveSessions = new Map<string, LiveVoiceSession>();

export function setLiveSession(userId: string, session: LiveVoiceSession | null) {
    if (session) liveSessions.set(userId, session);
    else liveSessions.delete(userId);
    notify();
}

export function getLiveSession(userId: string): LiveVoiceSession | undefined {
    return liveSessions.get(userId);
}

// Short-lived typing indicator: { userId -> { channelId, until } }
export interface TypingState { channelId: string; until: number; }
const typingState = new Map<string, TypingState>();

export function setTyping(userId: string, channelId: string, ttlMs = 10_000) {
    typingState.set(userId, { channelId, until: Date.now() + ttlMs });
    notify();
}

export function getTyping(userId: string): TypingState | undefined {
    const t = typingState.get(userId);
    if (!t) return undefined;
    if (t.until < Date.now()) { typingState.delete(userId); return undefined; }
    return t;
}

export function clearTyping(userId: string) {
    if (typingState.delete(userId)) notify();
}

let subscribers: (() => void)[] = [];
let initialized = false;

const MAX_IN_MEMORY = 2000;

function notify() {
    for (const fn of subscribers) fn();
}

export function subscribe(fn: () => void): () => void {
    subscribers = [...subscribers, fn];
    return () => {
        subscribers = subscribers.filter(x => x !== fn);
    };
}

export function getTracked(): TrackedMap {
    return tracked;
}

export function isTracked(userId: string): boolean {
    return userId in tracked;
}

export function getEntries(userId: string): StalkerEntry[] {
    return logs.get(userId) ?? [];
}

const DS_TRACKED_KEY = "userStalker:tracked";

function isValidTrackedMap(x: unknown): x is TrackedMap {
    if (!x || typeof x !== "object" || Array.isArray(x)) return false;
    for (const [k, v] of Object.entries(x as any)) {
        if (!/^\d{15,25}$/.test(k)) return false;
        if (!v || typeof v !== "object") return false;
        const e = v as any;
        if (typeof e.id !== "string" || e.id !== k) return false;
        if (typeof e.addedAt !== "number") return false;
        if (e.username !== undefined && typeof e.username !== "string") return false;
        if (e.notify !== undefined && typeof e.notify !== "boolean") return false;
    }
    return true;
}

async function saveTrackedEverywhere() {
    try { await DataStore.set(DS_TRACKED_KEY, tracked); } catch (e) { logger.error("DataStore save failed", e); }
    const n = getNative();
    if (n) {
        try { await n.saveTracked(tracked); } catch (e) { logger.error("native saveTracked failed", e); }
    } else {
        warnNoNative();
    }
}

export async function initStore(dataDir: string) {
    // Always pull tracked users from DataStore first (survives even without native).
    try {
        const ds = await DataStore.get<TrackedMap>(DS_TRACKED_KEY);
        if (ds) for (const id of Object.keys(ds)) tracked[id] = ds[id];
    } catch (e) {
        logger.error("DataStore load failed", e);
    }

    const n = getNative();
    if (!n) {
        warnNoNative();
        initialized = true;
        notify();
        return;
    }

    try {
        await n.init(dataDir);
        let savedTracked = await n.getTracked();
        // Validate schema; on failure try backups in newest-first order.
        if (!isValidTrackedMap(savedTracked) || Object.keys(savedTracked).length === 0 && Object.keys(tracked).length > 0) {
            if (!isValidTrackedMap(savedTracked)) {
                logger.warn("tracked.json failed schema validation, trying backups");
                try {
                    const backups = await n.listTrackedBackups();
                    for (const b of backups) {
                        const candidate = await n.readTrackedBackup(b);
                        if (isValidTrackedMap(candidate)) {
                            savedTracked = candidate;
                            logger.warn(`recovered tracked from backup ${b}`);
                            break;
                        }
                    }
                } catch (e) {
                    logger.error("backup recovery failed", e);
                }
            }
        }
        if (isValidTrackedMap(savedTracked) && Object.keys(savedTracked).length > 0) {
            for (const id of Object.keys(savedTracked)) tracked[id] = savedTracked[id];
        } else {
            // first run after we only had DataStore — mirror to disk
            await n.saveTracked(tracked);
        }
        for (const id of Object.keys(tracked)) {
            try {
                const lines = await n.readUserLog(id, MAX_IN_MEMORY);
                const parsed: StalkerEntry[] = [];
                for (const l of lines) {
                    try { parsed.push(JSON.parse(l)); } catch { /* skip */ }
                }
                logs.set(id, parsed);
            } catch (e) {
                logger.error(`readUserLog failed for ${id}`, e);
            }
        }
        initialized = true;
        notify();
    } catch (e) {
        logger.error("initStore failed", e);
        initialized = true;
        notify();
    }
}

let onAddHook: ((userId: string) => void) | null = null;
export function setOnTrackAddedHook(fn: (userId: string) => void) {
    onAddHook = fn;
}

export async function addTracked(user: TrackedUser) {
    const isNew = !(user.id in tracked);
    tracked[user.id] = user;
    if (!logs.has(user.id)) logs.set(user.id, []);
    await saveTrackedEverywhere();
    notify();
    if (isNew) onAddHook?.(user.id);
}

export async function removeTracked(userId: string, wipeLogs = false) {
    delete tracked[userId];
    const n = getNative();
    if (wipeLogs) {
        logs.delete(userId);
        if (n) {
            try { await n.clearUserLog(userId); } catch (e) { logger.error("clearUserLog failed", e); }
        }
    }
    await saveTrackedEverywhere();
    notify();
}

export async function setTrackedNotify(userId: string, notify_: boolean) {
    if (!tracked[userId]) return;
    tracked[userId].notify = notify_;
    await saveTrackedEverywhere();
    notify();
}

// Serialize disk appends per user so burst-writes (e.g. message spam) never interleave.
const writeChains = new Map<string, Promise<void>>();

function queueAppend(userId: string, line: string) {
    const n = getNative();
    if (!n) return;
    const prev = writeChains.get(userId) ?? Promise.resolve();
    const next = prev
        .catch(() => { /* don't let one failure poison the chain */ })
        .then(() => n.appendEntry(userId, line))
        .catch(e => logger.error(`appendEntry failed for ${userId}`, e));
    writeChains.set(userId, next);
}

export async function logEntry(entry: StalkerEntry) {
    if (!isTracked(entry.userId)) return;
    const list = logs.get(entry.userId) ?? [];
    list.push(entry);
    if (list.length > MAX_IN_MEMORY) list.splice(0, list.length - MAX_IN_MEMORY);
    logs.set(entry.userId, list);
    notify();
    queueAppend(entry.userId, JSON.stringify(entry));
}

/**
 * Download an attachment to disk so the image/file survives Discord CDN expiry.
 * Returns local path or null. Runs best-effort; errors are logged but never thrown.
 */
export async function persistAttachment(userId: string, messageId: string, idx: number, url: string, filename: string): Promise<string | null> {
    const n = getNative();
    if (!n) return null;
    try {
        return await n.downloadAttachment(userId, messageId, idx, url, filename);
    } catch (e) {
        logger.error("persistAttachment failed", e);
        return null;
    }
}

export async function loadFullHistory(userId: string): Promise<number> {
    const n = getNative();
    if (!n) return logs.get(userId)?.length ?? 0;
    try {
        const lines = await n.readUserLog(userId, 0); // 0 = unlimited
        const parsed: StalkerEntry[] = [];
        for (const l of lines) {
            try { parsed.push(JSON.parse(l)); } catch { /* skip */ }
        }
        logs.set(userId, parsed);
        notify();
        return parsed.length;
    } catch (e) {
        logger.error("loadFullHistory failed", e);
        return logs.get(userId)?.length ?? 0;
    }
}

export async function countOnDisk(userId: string): Promise<number> {
    const n = getNative();
    if (!n) return logs.get(userId)?.length ?? 0;
    try { return await n.countUserLog(userId); } catch { return logs.get(userId)?.length ?? 0; }
}

export async function clearUser(userId: string) {
    logs.set(userId, []);
    const n = getNative();
    if (n) {
        try { await n.clearUserLog(userId); } catch (e) { logger.error("clearUserLog failed", e); }
    }
    notify();
}

export async function setDataDir(dir: string) {
    const n = getNative();
    if (n) await n.setDataDir(dir);
}

export async function openDataDir() {
    const n = getNative();
    if (n) await n.openDataDirInExplorer();
    else warnNoNative();
}

export function hasNative(): boolean {
    return getNative() !== null;
}

export function isInitialized() {
    return initialized;
}
