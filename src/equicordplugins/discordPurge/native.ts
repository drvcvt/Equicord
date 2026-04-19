/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { IpcMainInvokeEvent } from "electron";

/**
 * Only allow downloading the installer from the official release artefacts.
 * This blocks the plugin being abused as a drive-by installer for arbitrary
 * binaries via a crafted IPC call.
 */
const ALLOWED_URL_PREFIX = "https://github.com/drvcvt/discord-purge/releases/";
const DEFAULT_URL = "https://github.com/drvcvt/discord-purge/releases/latest/download/discord-purge-setup.exe";

export async function downloadSetup(
    _: IpcMainInvokeEvent,
    urlOverride?: string
): Promise<{ ok: boolean; path?: string; error?: string; }> {
    const url = urlOverride ?? DEFAULT_URL;
    if (!url.startsWith(ALLOWED_URL_PREFIX)) {
        return { ok: false, error: "refused: url not in allowed prefix" };
    }
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        const dest = path.join(tmpdir(), `discord-purge-setup-${Date.now()}.exe`);
        await writeFile(dest, buf);
        return { ok: true, path: dest };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
    }
}

/**
 * Run an installer silently. Only paths inside the OS temp dir are accepted
 * and the filename must end with .exe — minimal guardrails so the IPC can't
 * be coerced into executing arbitrary files.
 */
export async function runSilentInstaller(
    _: IpcMainInvokeEvent,
    installerPath: string
): Promise<{ ok: boolean; code?: number; error?: string; }> {
    if (process.platform !== "win32") {
        return { ok: false, error: "windows only" };
    }
    const resolved = path.resolve(installerPath);
    const tmpResolved = path.resolve(tmpdir()) + path.sep;
    if (!(resolved + path.sep).startsWith(tmpResolved)) {
        return { ok: false, error: "refused: installer must live under system temp" };
    }
    if (!resolved.toLowerCase().endsWith(".exe")) {
        return { ok: false, error: "refused: not an .exe" };
    }
    return new Promise(resolve => {
        try {
            const child = spawn(resolved, ["/S"], {
                detached: false,
                windowsHide: true,
                stdio: "ignore"
            });
            child.on("error", err => resolve({ ok: false, error: err.message }));
            child.on("exit", code => resolve({ ok: code === 0, code: code ?? -1 }));
        } catch (e: any) {
            resolve({ ok: false, error: e?.message ?? String(e) });
        }
    });
}
