/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

const settings = definePluginSettings({
    dataDir: {
        type: OptionType.STRING,
        description: "Directory where stalker data is stored on disk.",
        default: "T:\\stalker-data"
    },
    logMessages: {
        type: OptionType.BOOLEAN,
        description: "Log messages sent by tracked users (channel, content, attachments).",
        default: true
    },
    logMessageEdits: {
        type: OptionType.BOOLEAN,
        description: "Log when tracked users edit their messages.",
        default: true
    },
    logMessageDeletes: {
        type: OptionType.BOOLEAN,
        description: "Log when tracked users delete their messages (only works if you've seen them).",
        default: true
    },
    logDMs: {
        type: OptionType.BOOLEAN,
        description: "Also log messages in DMs and group DMs.",
        default: true
    },
    logVoice: {
        type: OptionType.BOOLEAN,
        description: "Log voice channel joins, leaves, moves, mute/deafen, camera, screenshare.",
        default: true
    },
    logSoundboard: {
        type: OptionType.BOOLEAN,
        description: "Log soundboard usage in shared voice channels.",
        default: true
    },
    logActivity: {
        type: OptionType.BOOLEAN,
        description: "Log embedded activities (watch parties, games).",
        default: true
    },
    logPresence: {
        type: OptionType.BOOLEAN,
        description: "Log online/idle/dnd/offline transitions.",
        default: true
    },
    notifyOnMessage: {
        type: OptionType.BOOLEAN,
        description: "Show a Discord notification when a tracked user sends a message.",
        default: false
    },
    notifyOnVoiceJoin: {
        type: OptionType.BOOLEAN,
        description: "Notify when a tracked user joins any voice channel.",
        default: true
    },
    notifyOnOnline: {
        type: OptionType.BOOLEAN,
        description: "Notify when a tracked user comes online.",
        default: false
    }
});

export default settings;
