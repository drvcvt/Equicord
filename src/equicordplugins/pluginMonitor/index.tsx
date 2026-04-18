/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, useEffect, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { PluginMonitorModal } from "./PluginMonitorModal";

function openMonitor() {
    openModal(modalProps => <PluginMonitorModal modalProps={modalProps} />);
}

function formatHotkey(keys: string[]) {
    return keys.length ? keys.join(" + ") : "None";
}

function HotkeyRecorder({ setValue, setError, option }: { setValue(v: string[]): void; setError(e: string | null): void; option: { default: string[]; }; }) {
    const [value, setLocal] = useState<string[]>(() => {
        const stored = settings.store.hotkey;
        return Array.isArray(stored) && stored.length ? stored : option.default;
    });
    const [recording, setRecording] = useState(false);

    useEffect(() => {
        if (!recording) return;
        const captured = new Set<string>();

        const norm = (e: KeyboardEvent) => {
            const mods: string[] = [];
            if (e.ctrlKey) mods.push("Control");
            if (e.shiftKey) mods.push("Shift");
            if (e.altKey) mods.push("Alt");
            if (e.metaKey) mods.push("Meta");
            const k = e.key;
            if (k && !["Control", "Shift", "Alt", "Meta"].includes(k)) mods.push(k.length === 1 ? k.toUpperCase() : k);
            return mods;
        };

        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const combo = norm(e);
            if (combo.some(c => c.length === 1 || !["Control", "Shift", "Alt", "Meta"].includes(c))) {
                setLocal(combo);
                setValue(combo);
                setError(null);
                setRecording(false);
                captured.clear();
                return;
            }
            combo.forEach(c => captured.add(c));
        };

        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, [recording, setValue, setError]);

    return (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
                type="button"
                className={`vc-pm-recorder ${recording ? "vc-pm-recording" : ""}`}
                onClick={() => setRecording(r => !r)}
            >
                {recording ? "Press keys..." : <span className="vc-pm-kbd">{formatHotkey(value)}</span>}
            </button>
            <button type="button" className="vc-pm-recorder" onClick={() => { setLocal([]); setValue([]); }}>Clear</button>
        </div>
    );
}

export const settings = definePluginSettings({
    hotkey: {
        type: OptionType.COMPONENT,
        description: "Hotkey to open the task manager (default: Ctrl+Shift+P)",
        default: ["Control", "Shift", "P"],
        component: props => <HotkeyRecorder {...props as any} />
    } as any
});

function matchesHotkey(e: KeyboardEvent, combo: string[]) {
    if (!combo.length) return false;
    const needCtrl = combo.includes("Control");
    const needShift = combo.includes("Shift");
    const needAlt = combo.includes("Alt");
    const needMeta = combo.includes("Meta");
    if (needCtrl !== e.ctrlKey) return false;
    if (needShift !== e.shiftKey) return false;
    if (needAlt !== e.altKey) return false;
    if (needMeta !== e.metaKey) return false;

    const plain = combo.filter(k => !["Control", "Shift", "Alt", "Meta"].includes(k));
    if (plain.length !== 1) return false;
    const key = plain[0];
    return e.key.toUpperCase() === key.toUpperCase() || e.code === `Key${key.toUpperCase()}`;
}

function onKeyDown(e: KeyboardEvent) {
    const combo = settings.store.hotkey as string[] | undefined;
    if (!combo || !Array.isArray(combo)) return;
    if (matchesHotkey(e, combo)) {
        e.preventDefault();
        openMonitor();
    }
}

export default definePlugin({
    name: "PluginMonitor",
    description: "Task-manager-style overlay showing which plugins consume the most CPU time (start, patches, flux handlers). Open via hotkey (default Ctrl+Shift+P) or the Equicord Toolbox.",
    authors: [EquicordDevs.Matti],
    settings,

    toolboxActions: {
        "Open Task Manager": openMonitor
    },

    contextMenus: {
        "user-settings-cog": (children: Array<ReactNode>) => {
            children.push(
                <Menu.MenuItem
                    id="vc-plugin-monitor-open"
                    label="Plugin Task Manager"
                    action={openMonitor}
                />
            );
        }
    },

    start() {
        document.addEventListener("keydown", onKeyDown, true);
    },

    stop() {
        document.removeEventListener("keydown", onKeyDown, true);
    }
});
