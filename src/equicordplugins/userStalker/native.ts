/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { access, appendFile, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { IpcMainInvokeEvent, shell } from "electron";

const DEFAULT_DATA_DIR = "T:\\stalker-data";
const TRACKED_FILE = "tracked.json";
const LOGS_SUBDIR = "logs";
const ATTACHMENTS_SUBDIR = "attachments";
const BACKUPS_SUBDIR = "backups";
const MAX_BACKUPS = 14;

let dataDir = DEFAULT_DATA_DIR;

async function exists(p: string) {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

async function ensureDir(p: string) {
    if (!await exists(p)) await mkdir(p, { recursive: true });
}

function logsDir() {
    return path.join(dataDir, LOGS_SUBDIR);
}

function userLogFile(userId: string) {
    if (!/^\d+$/.test(userId)) throw new Error("Invalid userId");
    return path.join(logsDir(), `${userId}.jsonl`);
}

export async function setDataDir(_: IpcMainInvokeEvent, dir: string) {
    dataDir = dir || DEFAULT_DATA_DIR;
    await ensureDir(dataDir);
    await ensureDir(logsDir());
    return dataDir;
}

export async function getDataDir(_: IpcMainInvokeEvent) {
    return dataDir;
}

export async function init(_: IpcMainInvokeEvent, dir?: string) {
    if (dir) dataDir = dir;
    await ensureDir(dataDir);
    await ensureDir(logsDir());
}

export async function getTracked(_: IpcMainInvokeEvent): Promise<Record<string, any>> {
    const p = path.join(dataDir, TRACKED_FILE);
    if (!await exists(p)) return {};
    try {
        return JSON.parse(await readFile(p, "utf8"));
    } catch {
        return {};
    }
}

function backupsDir() {
    return path.join(dataDir, BACKUPS_SUBDIR);
}

async function rotateBackups(targetFile: string, tag: string) {
    try {
        await ensureDir(backupsDir());
        if (!await exists(targetFile)) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const dest = path.join(backupsDir(), `${tag}-${stamp}.json`);
        await copyFile(targetFile, dest);
        const entries = (await readdir(backupsDir())).filter(f => f.startsWith(`${tag}-`)).sort();
        while (entries.length > MAX_BACKUPS) {
            const old = entries.shift()!;
            try { await rm(path.join(backupsDir(), old)); } catch { /* ignore */ }
        }
    } catch { /* backup is best-effort */ }
}

export async function saveTracked(_: IpcMainInvokeEvent, tracked: Record<string, any>) {
    await ensureDir(dataDir);
    const target = path.join(dataDir, TRACKED_FILE);
    await rotateBackups(target, "tracked");
    const tmp = target + ".tmp";
    await writeFile(tmp, JSON.stringify(tracked, null, 2), "utf8");
    await rename(tmp, target);
}

export async function listTrackedBackups(_: IpcMainInvokeEvent): Promise<string[]> {
    try {
        await ensureDir(backupsDir());
        const all = await readdir(backupsDir());
        return all.filter(f => f.startsWith("tracked-")).sort().reverse();
    } catch { return []; }
}

export async function readTrackedBackup(_: IpcMainInvokeEvent, filename: string): Promise<Record<string, any> | null> {
    // prevent path traversal
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
    const p = path.join(backupsDir(), filename);
    if (!await exists(p)) return null;
    try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}

export async function appendEntry(_: IpcMainInvokeEvent, userId: string, entryJson: string) {
    await ensureDir(logsDir());
    await appendFile(userLogFile(userId), entryJson + "\n", "utf8");
}

export async function readUserLog(_: IpcMainInvokeEvent, userId: string, limit = 5000): Promise<string[]> {
    const p = userLogFile(userId);
    if (!await exists(p)) return [];
    const raw = await readFile(p, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (limit <= 0 || lines.length <= limit) return lines;
    return lines.slice(lines.length - limit);
}

export async function countUserLog(_: IpcMainInvokeEvent, userId: string): Promise<number> {
    const p = userLogFile(userId);
    if (!await exists(p)) return 0;
    const raw = await readFile(p, "utf8");
    let count = 0;
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) count++;
    // handle final line without newline
    if (raw.length > 0 && raw.charCodeAt(raw.length - 1) !== 10) count++;
    return count;
}

export async function clearUserLog(_: IpcMainInvokeEvent, userId: string) {
    const p = userLogFile(userId);
    if (await exists(p)) await rm(p);
}

export async function listLoggedUsers(_: IpcMainInvokeEvent): Promise<string[]> {
    await ensureDir(logsDir());
    const files = await readdir(logsDir());
    return files
        .filter(f => f.endsWith(".jsonl"))
        .map(f => f.replace(/\.jsonl$/, ""));
}

export async function openDataDirInExplorer(_: IpcMainInvokeEvent) {
    shell.openPath(dataDir);
}

function attachmentsDirFor(userId: string): string {
    if (!/^\d+$/.test(userId)) throw new Error("Invalid userId");
    return path.join(dataDir, ATTACHMENTS_SUBDIR, userId);
}

function sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

export async function downloadAttachment(
    _: IpcMainInvokeEvent,
    userId: string,
    messageId: string,
    idx: number,
    url: string,
    filename: string
): Promise<string | null> {
    if (!/^\d+$/.test(userId) || !/^\d+$/.test(messageId)) return null;
    try {
        const dir = attachmentsDirFor(userId);
        await ensureDir(dir);
        const safeName = sanitizeFilename(filename || "file");
        const finalPath = path.join(dir, `${messageId}-${idx}-${safeName}`);
        if (await exists(finalPath)) return finalPath;
        const res = await fetch(url);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        await writeFile(finalPath, Buffer.from(ab));
        return finalPath;
    } catch {
        return null;
    }
}

export async function readAttachment(_: IpcMainInvokeEvent, localPath: string): Promise<{ data: Uint8Array; } | null> {
    // only allow paths strictly inside the attachments subdir (prevents path-traversal)
    const baseResolved = path.resolve(path.join(dataDir, ATTACHMENTS_SUBDIR)) + path.sep;
    const resolved = path.resolve(localPath);
    if (!(resolved + path.sep).startsWith(baseResolved)) return null;
    try {
        const buf = await readFile(resolved);
        return { data: new Uint8Array(buf) };
    } catch {
        return null;
    }
}
