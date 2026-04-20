/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RelationshipStore } from "@webpack/common";

import settings from "./settings";

// Soft UserStalker integration: the UserStalker plugin exposes its tracked map
// via its own store module. Importing doesn't force UserStalker to be enabled —
// if it isn't, the map is simply empty and these helpers return false.
// Using dynamic access so any future breakage there doesn't explode us.
function userStalkerTracked(userId: string): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("../userStalker/store") as { getTracked?: () => Record<string, unknown>; isTracked?: (id: string) => boolean; };
        if (typeof mod.isTracked === "function") return !!mod.isTracked(userId);
        const map = mod.getTracked?.();
        return !!(map && map[userId]);
    } catch {
        return false;
    }
}

function parseExtraIds(): Set<string> {
    const raw = (settings.store.extraTrackedIds as string | undefined) ?? "";
    const ids = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    return new Set(ids);
}

/**
 * Is this user watched? A user is watched if any of:
 *   - they're in the manual extra list (always authoritative)
 *   - `includeFriends` is on and RelationshipStore says they're a friend
 *   - UserStalker is installed & enabled and has them in its tracked map
 *
 * This is independent of `stalkerMode` — call sites decide *when* to consult
 * the tracking status (e.g. voice events only consult it when stalkerMode
 * is on, so in-VC events alone don't depend on tracking at all).
 */
export function isTrackedUser(userId: string): boolean {
    if (!userId) return false;

    const extra = parseExtraIds();
    if (extra.has(userId)) return true;

    if (settings.store.includeFriends) {
        try { if (RelationshipStore.isFriend(userId)) return true; } catch { /* */ }
    }

    if (userStalkerTracked(userId)) return true;

    return false;
}
