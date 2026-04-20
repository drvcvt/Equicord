/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

const settings = definePluginSettings({
    // Layout
    topOffset: {
        type: OptionType.SLIDER,
        description: "Distance from top of window (px). Increase if it overlaps your title bar.",
        default: 32,
        markers: [0, 12, 24, 32, 48, 64, 96],
        min: 0,
        max: 120
    },
    showOnHover: {
        type: OptionType.BOOLEAN,
        description: "Expand the island on hover (otherwise click).",
        default: true
    },
    compactMaxWidth: {
        type: OptionType.SLIDER,
        description: "Max width of the compact pill (px).",
        default: 360,
        markers: [240, 320, 360, 440, 520],
        min: 200,
        max: 600
    },

    // Sources — all gated by UserStalker tracked list
    notifyMessages: {
        type: OptionType.BOOLEAN,
        description: "Show when a tracked user sends a message (mentions/DMs are highlighted).",
        default: true
    },
    notifyVoice: {
        type: OptionType.BOOLEAN,
        description: "Show when a tracked user joins, leaves, or moves voice channels.",
        default: true
    },
    notifyStream: {
        type: OptionType.BOOLEAN,
        description: "Show when a tracked user starts streaming/screen sharing.",
        default: true
    },
    notifyOnline: {
        type: OptionType.BOOLEAN,
        description: "Show when a tracked user comes online.",
        default: true
    },
    notifyActivity: {
        type: OptionType.BOOLEAN,
        description: "Show when a tracked user starts a new activity (game, listening, etc.).",
        default: false
    },
    notifySoundboard: {
        type: OptionType.BOOLEAN,
        description: "Show soundboard plays in your current voice channel (any user).",
        default: true
    },
    notifyVcMembers: {
        type: OptionType.BOOLEAN,
        description: "While you're in a voice channel, show events (joins, leaves, streams) for everyone in that channel — not only tracked users.",
        default: true
    },

    // Live activities (persistent, sticky)
    liveVoiceCall: {
        type: OptionType.BOOLEAN,
        description: "Live activity: persistent pill while you're in a voice channel (mute/deafen/leave controls).",
        default: true
    },
    liveScreenShare: {
        type: OptionType.BOOLEAN,
        description: "Live activity: persistent REC pill with elapsed time + stop button while you're streaming.",
        default: true
    },
    liveDraftTracker: {
        type: OptionType.BOOLEAN,
        description: "Live activity: pill for any unsent draft in a channel you're not currently viewing.",
        default: true
    },

    // Behavior
    defaultDuration: {
        type: OptionType.SLIDER,
        description: "Default visible duration for non-sticky events (seconds).",
        default: 6,
        markers: [3, 5, 6, 8, 12, 20],
        min: 2,
        max: 30
    },
    suppressWhenFocused: {
        type: OptionType.BOOLEAN,
        description: "Don't show messages if you're already viewing that channel.",
        default: true
    },

    // Hub (right-click panel with Voice / Messages / Online tabs)
    hubAccent: {
        type: OptionType.STRING,
        description: "Hub accent color (CSS color — hex, rgb, or color name). Controls tab indicator, voice indicator, focus ring, and selection color.",
        default: "#a892ff"
    },
    hubFont: {
        type: OptionType.STRING,
        description: "Hub font family override (CSS font-family value). Leave empty to inherit Discord's font.",
        default: ""
    },
    hubDensity: {
        type: OptionType.SELECT,
        description: "Hub row density.",
        options: [
            { label: "Compact", value: "compact" },
            { label: "Cozy", value: "cozy", default: true },
            { label: "Spacious", value: "spacious" }
        ]
    },
    hubWidth: {
        type: OptionType.SLIDER,
        description: "Hub width (px).",
        default: 380,
        markers: [320, 360, 380, 440, 520],
        min: 320,
        max: 560
    }
});

export default settings;
