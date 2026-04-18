/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { CloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { PatchReplacement, Plugin } from "@utils/types";
import { patches, patchTimings } from "@webpack/patcher";
import { React, useEffect, useMemo, useState } from "@webpack/common";

import Plugins from "~plugins";

import { fluxRatePerSec, pluginStats, readHeap, resetPluginStats } from "../../debug/pluginStats";

type SortKey = "name" | "startMs" | "moduleInitMs" | "patchCount" | "fluxMs" | "fluxRate" | "renderMs" | "totalMs";

interface PatchDetail {
    moduleId: PropertyKey;
    match: PatchReplacement["match"];
    totalTime: number;
}

interface Row {
    name: string;
    enabled: boolean;
    plugin?: Plugin;
    startMs: number;
    startHeapDelta: number;
    moduleInitMs: number;
    moduleInitCount: number;
    patchCompileMs: number;
    patchCount: number;
    patchDetails: PatchDetail[];
    fluxMs: number;
    fluxMaxMs: number;
    fluxCount: number;
    fluxRate: number;
    fluxEvents: Array<{ event: string; totalMs: number; count: number; maxMs: number; rate: number; }>;
    renderMs: number;
    renderCount: number;
    renderByKind: Array<{ kind: string; totalMs: number; count: number; maxMs: number; }>;
    totalMs: number;
    commandCount: number;
    contextMenuCount: number;
    dependencies: string[];
    managedStyle: boolean;
    patchesDefined: number;
}

function fmtMs(ms: number) {
    if (!Number.isFinite(ms)) return "–";
    if (ms === 0) return "0";
    if (ms < 0.01) return (ms * 1000).toFixed(0) + "µs";
    if (ms < 1) return (ms * 1000).toFixed(0) + "µs";
    if (ms >= 100) return ms.toFixed(0) + "ms";
    if (ms >= 10) return ms.toFixed(1) + "ms";
    return ms.toFixed(2) + "ms";
}

function fmtBytes(bytes: number) {
    if (!Number.isFinite(bytes)) return "n/a";
    const abs = Math.abs(bytes);
    const sign = bytes < 0 ? "-" : "+";
    if (abs < 1024) return `${sign}${abs.toFixed(0)} B`;
    if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
    return `${sign}${(abs / 1024 / 1024).toFixed(2)} MB`;
}

function heat(ms: number): string {
    if (ms > 50) return "vc-pm-heat-high";
    if (ms > 10) return "vc-pm-heat-med";
    return "vc-pm-heat-low";
}

function collectRows(): Row[] {
    const compileByPlugin = new Map<string, number>();
    const patchDetailsByPlugin = new Map<string, PatchDetail[]>();
    const patchCountByPlugin = new Map<string, number>();

    for (const [plugin, moduleId, match, ms] of patchTimings) {
        compileByPlugin.set(plugin, (compileByPlugin.get(plugin) ?? 0) + ms);
        const arr = patchDetailsByPlugin.get(plugin) ?? [];
        arr.push({ moduleId, match, totalTime: ms });
        patchDetailsByPlugin.set(plugin, arr);
    }

    for (const p of patches) {
        const replacements = Array.isArray(p.replacement) ? p.replacement.length : 1;
        patchCountByPlugin.set(p.plugin, (patchCountByPlugin.get(p.plugin) ?? 0) + replacements);
    }

    const names = new Set<string>([
        ...Object.keys(Plugins),
        ...compileByPlugin.keys(),
        ...patchCountByPlugin.keys(),
        ...pluginStats.keys()
    ]);

    const rows: Row[] = [];
    for (const name of names) {
        const s = pluginStats.get(name);
        const plugin = Plugins[name];
        const startMs = s?.startMs ?? 0;
        const fluxMs = s?.fluxTotalMs ?? 0;
        const fluxCount = s?.fluxCallCount ?? 0;
        const patchCompileMs = compileByPlugin.get(name) ?? 0;
        const patchCount = patchCountByPlugin.get(name) ?? 0;
        const fluxRate = s ? fluxRatePerSec(s.fluxRecent) : 0;

        const fluxEvents = s
            ? Object.entries(s.fluxByEvent).map(([event, v]) => ({
                event,
                totalMs: v.totalMs,
                count: v.count,
                maxMs: v.maxMs,
                rate: fluxRatePerSec(v.recent)
            })).sort((a, b) => b.totalMs - a.totalMs)
            : [];

        const patchDetails = (patchDetailsByPlugin.get(name) ?? []).sort((a, b) => b.totalTime - a.totalTime);

        const renderByKind = s
            ? Object.entries(s.renderByKind).map(([kind, v]) => ({
                kind, totalMs: v.totalMs, count: v.count, maxMs: v.maxMs
            })).sort((a, b) => b.totalMs - a.totalMs)
            : [];

        const moduleInitMs = s?.moduleInitMs ?? 0;
        const renderMs = s?.renderTotalMs ?? 0;

        rows.push({
            name,
            enabled: !!plugin && isPluginEnabled(name),
            plugin,
            startMs,
            startHeapDelta: s?.startHeapDelta ?? NaN,
            moduleInitMs,
            moduleInitCount: s?.moduleInitCount ?? 0,
            patchCompileMs,
            patchCount,
            patchDetails,
            fluxMs,
            fluxMaxMs: s?.fluxMaxMs ?? 0,
            fluxCount,
            fluxRate,
            fluxEvents,
            renderMs,
            renderCount: s?.renderCallCount ?? 0,
            renderByKind,
            totalMs: startMs + moduleInitMs + fluxMs + renderMs,
            commandCount: plugin?.commands?.length ?? 0,
            contextMenuCount: plugin?.contextMenus ? Object.keys(plugin.contextMenus).length : 0,
            dependencies: plugin?.dependencies ?? [],
            managedStyle: !!plugin?.managedStyle,
            patchesDefined: plugin?.patches?.length ?? 0
        });
    }
    return rows;
}

function describeMatch(m: PatchReplacement["match"]): string {
    const s = m instanceof RegExp ? m.source : String(m);
    return s.length > 90 ? s.slice(0, 87) + "..." : s;
}

function DetailView({ row }: { row: Row; }) {
    const authors = row.plugin?.authors?.map(a => a.name).join(", ") || "unknown";
    const heap = readHeap();
    return (
        <div className="vc-pm-detail">
            <div className="vc-pm-detail-grid">
                {row.plugin?.description && (
                    <>
                        <span className="vc-pm-detail-label">Description</span>
                        <span>{row.plugin.description}</span>
                    </>
                )}
                <span className="vc-pm-detail-label">Authors</span>
                <span>{authors}</span>
                <span className="vc-pm-detail-label">Patches declared</span>
                <span>{row.patchesDefined} ({row.patchCount} replacements)</span>
                <span className="vc-pm-detail-label">Commands</span>
                <span>{row.commandCount}</span>
                <span className="vc-pm-detail-label">Context menus</span>
                <span>{row.contextMenuCount}</span>
                <span className="vc-pm-detail-label">Managed style</span>
                <span>{row.managedStyle ? "yes" : "no"}</span>
                {row.dependencies.length > 0 && (
                    <>
                        <span className="vc-pm-detail-label">Dependencies</span>
                        <span>{row.dependencies.join(", ")}</span>
                    </>
                )}
                <span className="vc-pm-detail-label">Start heap delta</span>
                <span title="Very rough: JS heap change during start(). GC noise makes this directional only.">
                    {fmtBytes(row.startHeapDelta)}
                </span>
                <span className="vc-pm-detail-label">Patch compile time</span>
                <span>{fmtMs(row.patchCompileMs)} (one-off, string replace)</span>
                <span className="vc-pm-detail-label">Module init runtime</span>
                <span title="Time spent executing patched module factories — actual runtime cost of your injected code at module load">
                    {fmtMs(row.moduleInitMs)} across {row.moduleInitCount} module{row.moduleInitCount === 1 ? "" : "s"}
                </span>
                {row.fluxCount > 0 && (
                    <>
                        <span className="vc-pm-detail-label">Flux max per call</span>
                        <span>{fmtMs(row.fluxMaxMs)} (avg {fmtMs(row.fluxMs / row.fluxCount)})</span>
                    </>
                )}
                {row.renderCount > 0 && (
                    <>
                        <span className="vc-pm-detail-label">Render avg per call</span>
                        <span>{fmtMs(row.renderMs / row.renderCount)} ({row.renderCount} calls)</span>
                    </>
                )}
            </div>

            {row.renderByKind.length > 0 && (
                <div className="vc-pm-detail-section">
                    <BaseText size="sm" weight="semibold">Render callbacks</BaseText>
                    <table className="vc-pm-detail-table">
                        <tbody>
                            {row.renderByKind.map(rk => (
                                <tr key={rk.kind}>
                                    <td>{rk.kind}</td>
                                    <td className={`vc-pm-num ${heat(rk.totalMs)}`}>{fmtMs(rk.totalMs)}</td>
                                    <td className="vc-pm-num">avg {fmtMs(rk.totalMs / rk.count)}</td>
                                    <td className="vc-pm-num">max {fmtMs(rk.maxMs)}</td>
                                    <td className="vc-pm-num">{rk.count}x</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {row.fluxEvents.length > 0 && (
                <div className="vc-pm-detail-section">
                    <BaseText size="sm" weight="semibold">Flux events ({row.fluxEvents.length})</BaseText>
                    <table className="vc-pm-detail-table">
                        <tbody>
                            {row.fluxEvents.map(ev => (
                                <tr key={ev.event}>
                                    <td>{ev.event}</td>
                                    <td className={`vc-pm-num ${heat(ev.totalMs)}`}>{fmtMs(ev.totalMs)}</td>
                                    <td className="vc-pm-num">avg {fmtMs(ev.totalMs / ev.count)}</td>
                                    <td className="vc-pm-num">max {fmtMs(ev.maxMs)}</td>
                                    <td className="vc-pm-num">{ev.count}x</td>
                                    <td className="vc-pm-num">{ev.rate.toFixed(2)}/s</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {row.patchDetails.length > 0 && (
                <div className="vc-pm-detail-section">
                    <BaseText size="sm" weight="semibold">Patches ({row.patchDetails.length})</BaseText>
                    <table className="vc-pm-detail-table">
                        <tbody>
                            {row.patchDetails.map((p, i) => (
                                <tr key={i}>
                                    <td>{describeMatch(p.match)}</td>
                                    <td className="vc-pm-num">module {String(p.moduleId)}</td>
                                    <td className={`vc-pm-num ${heat(p.totalTime)}`}>{fmtMs(p.totalTime)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {Number.isFinite(heap) && (
                <div className="vc-pm-detail-section" style={{ color: "var(--text-muted)" }}>
                    Current total JS heap: {(heap / 1024 / 1024).toFixed(1)} MB (whole renderer, all plugins combined)
                </div>
            )}
        </div>
    );
}

function PluginMonitor({ modalProps }: { modalProps: ModalProps; }) {
    const [sortKey, setSortKey] = useState<SortKey>("totalMs");
    const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
    const [search, setSearch] = useState("");
    const [onlyEnabled, setOnlyEnabled] = useState(true);
    const [tick, setTick] = useState(0);
    const [expanded, setExpanded] = useState<string | null>(null);

    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, []);

    const rows = useMemo(() => {
        let r = collectRows();
        if (onlyEnabled) r = r.filter(row => row.enabled);
        const q = search.trim().toLowerCase();
        if (q) r = r.filter(row => row.name.toLowerCase().includes(q));

        r.sort((a, b) => {
            let cmp: number;
            if (sortKey === "name") cmp = a.name.localeCompare(b.name);
            else cmp = (a[sortKey] as number) - (b[sortKey] as number);
            return sortDir === "asc" ? cmp : -cmp;
        });
        return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sortKey, sortDir, search, onlyEnabled, tick]);

    const max = Math.max(1, ...rows.map(r => r.totalMs));

    const header = (key: SortKey, label: string) => (
        <th
            className={sortKey === key ? "vc-pm-sorted" : ""}
            data-dir={sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : ""}
            onClick={() => {
                if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
                else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
            }}
        >
            {label}
        </th>
    );

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE} className="vc-pm-modal">
            <ModalHeader separator={false}>
                <BaseText size="lg" weight="semibold" style={{ flex: 1 }}>
                    Vencord Plugin Task Manager
                </BaseText>
                <BaseText size="sm" style={{ color: "var(--text-muted)", marginRight: 12 }}>
                    {rows.length} plugin{rows.length === 1 ? "" : "s"}
                </BaseText>
                <CloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div className="vc-pm-toolbar">
                <input
                    className="vc-pm-search"
                    placeholder="Search plugins..."
                    value={search}
                    onChange={e => setSearch(e.currentTarget.value)}
                />
                <label>
                    <input
                        type="checkbox"
                        checked={onlyEnabled}
                        onChange={e => setOnlyEnabled(e.currentTarget.checked)}
                    />
                    Only enabled
                </label>
                <Button size="small" variant="secondary" onClick={() => { resetPluginStats(); setTick(t => t + 1); }}>
                    Reset
                </Button>
            </div>

            <ModalContent>
                {rows.length === 0 ? (
                    <div className="vc-pm-empty">No plugins match.</div>
                ) : (
                    <table className="vc-pm-table">
                        <thead>
                            <tr>
                                {header("name", "Plugin")}
                                {header("startMs", "Start")}
                                {header("moduleInitMs", "Module Init")}
                                {header("patchCount", "Patches")}
                                {header("fluxMs", "Flux ms")}
                                {header("fluxRate", "Flux/s")}
                                {header("renderMs", "Render ms")}
                                {header("totalMs", "Total CPU")}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => {
                                const pct = (r.totalMs / max) * 100;
                                const isExpanded = expanded === r.name;
                                return (
                                    <React.Fragment key={r.name}>
                                        <tr
                                            className={`vc-pm-row ${isExpanded ? "vc-pm-row-expanded" : ""}`}
                                            onClick={() => setExpanded(isExpanded ? null : r.name)}
                                        >
                                            <td>
                                                <span className={`vc-pm-chevron ${isExpanded ? "vc-pm-chevron-open" : ""}`}>▶</span>
                                                <span className={`vc-pm-plugin-name ${!r.enabled ? "vc-pm-plugin-name-off" : ""}`}>
                                                    {r.name}
                                                </span>
                                                {!r.enabled && <span className="vc-pm-badge">off</span>}
                                                {r.plugin?.required && <span className="vc-pm-badge">req</span>}
                                            </td>
                                            <td className={`vc-pm-num ${heat(r.startMs)}`}>{fmtMs(r.startMs)}</td>
                                            <td className={`vc-pm-num ${heat(r.moduleInitMs)}`} title={`${r.moduleInitCount} module init(s)`}>{fmtMs(r.moduleInitMs)}</td>
                                            <td className="vc-pm-num">{r.patchCount}</td>
                                            <td className={`vc-pm-num ${heat(r.fluxMs)}`}>{fmtMs(r.fluxMs)}</td>
                                            <td className="vc-pm-num">{r.fluxRate >= 0.01 ? r.fluxRate.toFixed(2) : "–"}</td>
                                            <td className={`vc-pm-num ${heat(r.renderMs)}`} title={`${r.renderCount} render call(s)`}>{fmtMs(r.renderMs)}</td>
                                            <td className={`vc-pm-num ${heat(r.totalMs)}`}>
                                                {fmtMs(r.totalMs)}
                                                <span className="vc-pm-bar" style={{ width: `${pct}%` }} />
                                            </td>
                                        </tr>
                                        {isExpanded && (
                                            <tr>
                                                <td colSpan={8} style={{ padding: 0 }}>
                                                    <DetailView row={r} />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </ModalContent>

            <div className="vc-pm-footer-info">
                Numbers are relative CPU time. Electron doesn't expose per-plugin RAM — all plugins share one heap.
                Module Init = time patched module factories took at load. Render = time your React callbacks took. Flux/s = calls/sec (last 10s).
                Click a row to expand. Heap delta uses performance.memory (Chromium, GC-noisy). Patch runtime inside Discord's own code can't be attributed per-plugin.
            </div>
        </ModalRoot>
    );
}

export function PluginMonitorModal({ modalProps }: { modalProps: ModalProps; }) {
    return (
        <ErrorBoundary>
            <PluginMonitor modalProps={modalProps} />
        </ErrorBoundary>
    );
}
