/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IslandEvent } from "./types";

const events: IslandEvent[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let subs: (() => void)[] = [];
let pushSubs: ((event: IslandEvent) => void)[] = [];
let counter = 0;

function notify() {
    for (const fn of subs) fn();
}

export function subscribe(fn: () => void): () => void {
    subs = [...subs, fn];
    return () => { subs = subs.filter(x => x !== fn); };
}

/**
 * Fires once per push() (including push-replace via stable id). External plugins
 * can subscribe to receive every event in real-time. Returns an unsubscribe fn.
 */
export function onPushEvent(fn: (event: IslandEvent) => void): () => void {
    pushSubs = [...pushSubs, fn];
    return () => { pushSubs = pushSubs.filter(x => x !== fn); };
}

export function getEvents(): IslandEvent[] {
    return events;
}

/**
 * The "currently displayed" transient event: highest priority, then most recent.
 * Live activities are excluded — they live in their own row.
 */
export function getActive(): IslandEvent | null {
    let best: IslandEvent | null = null;
    for (const e of events) {
        if (e.live) continue;
        if (!best || e.priority > best.priority || (e.priority === best.priority && e.createdAt > best.createdAt)) {
            best = e;
        }
    }
    return best;
}

/** All live activities, oldest-first (stable visual order). */
export function getLive(): IslandEvent[] {
    return events.filter(e => e.live).sort((a, b) => a.createdAt - b.createdAt);
}

export function push(partial: Omit<IslandEvent, "id" | "createdAt"> & { id?: string; createdAt?: number; }): string {
    const id = partial.id ?? `island-${Date.now()}-${++counter}`;
    // Replace existing event with same id (e.g. typing indicator refresh)
    const existingIdx = events.findIndex(e => e.id === id);
    const event: IslandEvent = {
        ...partial,
        id,
        createdAt: partial.createdAt ?? Date.now()
    } as IslandEvent;

    if (existingIdx >= 0) {
        const oldTimer = timers.get(id);
        if (oldTimer) { clearTimeout(oldTimer); timers.delete(id); }
        events[existingIdx] = event;
    } else {
        events.push(event);
    }

    if (event.duration && event.duration > 0) {
        const t = setTimeout(() => dismiss(id), event.duration);
        timers.set(id, t);
    }

    notify();
    for (const fn of pushSubs) {
        try { fn(event); } catch { /* swallow subscriber errors */ }
    }
    return id;
}

export function dismiss(id: string) {
    const idx = events.findIndex(e => e.id === id);
    if (idx < 0) return;
    events.splice(idx, 1);
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
    notify();
}

/** Cancel auto-dismiss for an event without removing it (e.g. while user is typing a reply). */
export function pauseDismiss(id: string) {
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
}

/** Restart auto-dismiss with a fresh duration. Useful after pauseDismiss when user cancels. */
export function resumeDismiss(id: string, durationMs: number) {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    if (durationMs > 0) {
        timers.set(id, setTimeout(() => dismiss(id), durationMs));
    }
}

/** Peek at an event by id without mutating anything. */
export function getById(id: string): IslandEvent | undefined {
    return events.find(e => e.id === id);
}

export function clearAll() {
    events.length = 0;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    notify();
}

export function dismissByType(type: IslandEvent["type"]) {
    for (const e of [...events]) {
        if (e.type === type) dismiss(e.id);
    }
}
