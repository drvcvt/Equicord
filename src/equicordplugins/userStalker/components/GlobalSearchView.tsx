/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore, React, ScrollerThin, TextInput, UserStore } from "@webpack/common";

import { formatRelative } from "../stats";
import { getEntries, getTracked } from "../store";
import { MessageEntry } from "../types";

interface Hit {
    userId: string;
    entry: MessageEntry;
}

function searchAll(query: string, limit = 300): Hit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: Hit[] = [];
    for (const userId of Object.keys(getTracked())) {
        const entries = getEntries(userId);
        // newest first
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.type !== "message" && e.type !== "message_edit") continue;
            const m = e as MessageEntry;
            const content = m.content?.toLowerCase() ?? "";
            const ch = m.channelId ? ChannelStore.getChannel(m.channelId) : null;
            const g = m.guildId ? GuildStore.getGuild(m.guildId) : null;
            if (
                content.includes(q)
                || (ch?.name?.toLowerCase().includes(q))
                || (g?.name?.toLowerCase().includes(q))
            ) {
                hits.push({ userId, entry: m });
                if (hits.length >= limit) return hits.sort((a, b) => b.entry.timestamp - a.entry.timestamp);
            }
        }
    }
    return hits.sort((a, b) => b.entry.timestamp - a.entry.timestamp);
}

function highlightMatch(text: string, query: string): React.ReactNode {
    if (!query) return text;
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) return text;
    return (
        <>
            {text.slice(0, idx)}
            <mark>{text.slice(idx, idx + q.length)}</mark>
            {text.slice(idx + q.length)}
        </>
    );
}

export function GlobalSearchView({ onOpenUser }: { onOpenUser: (id: string) => void; }) {
    const [query, setQuery] = React.useState("");
    const hits = React.useMemo(() => searchAll(query), [query]);
    const trimmed = query.trim();

    return (
        <div className="vc-stalker-globalsearch">
            <div className="vc-stalker-globalsearch-bar">
                <TextInput
                    placeholder="Search content / channel / server across ALL tracked users…"
                    value={query}
                    onChange={setQuery}
                    autoFocus
                />
                {trimmed && <div className="vc-stalker-globalsearch-count">{hits.length} hit{hits.length === 1 ? "" : "s"}</div>}
            </div>
            <ScrollerThin fade className="vc-stalker-globalsearch-results">
                {!trimmed && <div className="vc-stalker-empty">Type to search across all tracked users.</div>}
                {trimmed && hits.length === 0 && <div className="vc-stalker-empty">No matches.</div>}
                {hits.map((h, i) => {
                    const u = UserStore.getUser(h.userId);
                    const name = u?.globalName ?? u?.username ?? getTracked()[h.userId]?.username ?? h.userId;
                    const ch = h.entry.channelId ? ChannelStore.getChannel(h.entry.channelId) : null;
                    const g = h.entry.guildId ? GuildStore.getGuild(h.entry.guildId) : null;
                    return (
                        <div
                            key={`${h.entry.messageId}-${i}`}
                            className="vc-stalker-globalsearch-hit"
                            onClick={() => onOpenUser(h.userId)}
                        >
                            <div className="vc-stalker-globalsearch-hit-head">
                                <span className="vc-stalker-globalsearch-hit-user">{name}</span>
                                <span className="vc-stalker-globalsearch-hit-loc">
                                    {g?.name ?? "DM"} · {ch?.name ? `#${ch.name}` : h.entry.channelId}
                                </span>
                                <span className="vc-stalker-globalsearch-hit-time">
                                    {formatRelative(h.entry.timestamp)}
                                </span>
                            </div>
                            <div className="vc-stalker-globalsearch-hit-content">
                                {h.entry.content ? highlightMatch(h.entry.content.slice(0, 300), trimmed) : <i>[no content]</i>}
                                {h.entry.type === "message_edit" && <span className="vc-stalker-globalsearch-hit-edit"> (edited)</span>}
                            </div>
                        </div>
                    );
                })}
            </ScrollerThin>
        </div>
    );
}
