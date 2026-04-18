/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ReactNode } from "react";

export interface FluxEventStat {
    totalMs: number;
    count: number;
    maxMs: number;
    recent: number[];
}

export interface RenderKindStat {
    totalMs: number;
    count: number;
    maxMs: number;
}

export interface PluginRuntimeStats {
    startMs: number;
    startHeapDelta: number;
    moduleInitMs: number;
    moduleInitCount: number;
    fluxTotalMs: number;
    fluxCallCount: number;
    fluxMaxMs: number;
    fluxByEvent: Record<string, FluxEventStat>;
    fluxRecent: number[];
    renderTotalMs: number;
    renderCallCount: number;
    renderByKind: Record<string, RenderKindStat>;
}

const empty = (): PluginRuntimeStats => ({
    startMs: 0,
    startHeapDelta: NaN,
    moduleInitMs: 0,
    moduleInitCount: 0,
    fluxTotalMs: 0,
    fluxCallCount: 0,
    fluxMaxMs: 0,
    fluxByEvent: {},
    fluxRecent: [],
    renderTotalMs: 0,
    renderCallCount: 0,
    renderByKind: {}
});

export const pluginStats = new Map<string, PluginRuntimeStats>();

export function getStats(plugin: string): PluginRuntimeStats {
    let s = pluginStats.get(plugin);
    if (!s) {
        s = empty();
        pluginStats.set(plugin, s);
    }
    return s;
}

export function recordStart(plugin: string, ms: number, heapDelta: number) {
    const s = getStats(plugin);
    s.startMs += ms;
    if (Number.isFinite(heapDelta)) {
        s.startHeapDelta = Number.isFinite(s.startHeapDelta) ? s.startHeapDelta + heapDelta : heapDelta;
    }
}

export function recordModuleInit(plugin: string, ms: number) {
    const s = getStats(plugin);
    s.moduleInitMs += ms;
    s.moduleInitCount += 1;
}

export function recordFlux(plugin: string, event: string, ms: number) {
    const s = getStats(plugin);
    const now = performance.now();
    s.fluxTotalMs += ms;
    s.fluxCallCount += 1;
    if (ms > s.fluxMaxMs) s.fluxMaxMs = ms;
    s.fluxRecent.push(now);
    const e = s.fluxByEvent[event] ??= { totalMs: 0, count: 0, maxMs: 0, recent: [] };
    e.totalMs += ms;
    e.count += 1;
    if (ms > e.maxMs) e.maxMs = ms;
    e.recent.push(now);
}

export function recordRender(plugin: string, kind: string, ms: number) {
    const s = getStats(plugin);
    s.renderTotalMs += ms;
    s.renderCallCount += 1;
    const k = s.renderByKind[kind] ??= { totalMs: 0, count: 0, maxMs: 0 };
    k.totalMs += ms;
    k.count += 1;
    if (ms > k.maxMs) k.maxMs = ms;
}

const RATE_WINDOW_MS = 10_000;

export function fluxRatePerSec(recent: number[]): number {
    if (recent.length === 0) return 0;
    const cutoff = performance.now() - RATE_WINDOW_MS;
    let i = 0;
    while (i < recent.length && recent[i] < cutoff) i++;
    if (i > 0) recent.splice(0, i);
    return recent.length / (RATE_WINDOW_MS / 1000);
}

export function resetPluginStats() {
    pluginStats.clear();
}

export function readHeap(): number {
    return (performance as any).memory?.usedJSHeapSize ?? NaN;
}

export function wrapRender<A extends any[], R extends ReactNode>(plugin: string, kind: string, fn: (...args: A) => R): (...args: A) => R {
    if (typeof fn !== "function") return fn;
    return function wrapped(this: any, ...args: A): R {
        const t0 = performance.now();
        try {
            return fn.apply(this, args) as R;
        } finally {
            recordRender(plugin, kind, performance.now() - t0);
        }
    };
}
