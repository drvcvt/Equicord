/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./StalkerModal.css";

import { BaseText } from "@components/BaseText";
import {
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal
} from "@utils/modal";
import { Button, Forms, React, ScrollerThin, TextInput, UserStore } from "@webpack/common";

import { addTracked, getLiveSession, getTracked, hasNative, openDataDir, subscribe } from "../store";
import { GlobalSearchView } from "./GlobalSearchView";
import { NowWidget } from "./NowWidget";
import { UserPanel } from "./UserPanel";

function useStalkerState() {
    return React.useSyncExternalStore(subscribe, () => JSON.stringify(Object.keys(getTracked())));
}

function StalkerModal({ props, initialUserId }: { props: ModalProps; initialUserId?: string; }) {
    useStalkerState();
    const tracked = getTracked();
    const ids = Object.keys(tracked);

    const [selected, setSelected] = React.useState<string | null>(initialUserId ?? ids[0] ?? null);
    const [addId, setAddId] = React.useState("");
    const [searchMode, setSearchMode] = React.useState(false);

    React.useEffect(() => {
        if (selected && !tracked[selected]) {
            setSelected(ids[0] ?? null);
        }
    }, [selected, ids.join(",")]);

    const handleAdd = async () => {
        const id = addId.trim();
        if (!/^\d{15,25}$/.test(id)) return;
        const u = UserStore.getUser(id);
        await addTracked({
            id,
            username: u?.username,
            addedAt: Date.now(),
            notify: true
        });
        setAddId("");
        setSelected(id);
    };

    return (
        <ModalRoot {...props} size={ModalSize.LARGE} className="vc-stalker-modal">
            <ModalHeader>
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>
                    User Stalker
                </BaseText>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>

            <ModalContent className="vc-stalker-content">
                <NowWidget onSelectUser={setSelected} />
                <div className="vc-stalker-body">
                    <div className="vc-stalker-sidebar">
                        <div className="vc-stalker-add">
                            <TextInput
                                placeholder="User ID…"
                                value={addId}
                                onChange={setAddId}
                            />
                            <Button size={Button.Sizes.SMALL} onClick={handleAdd}>Add</Button>
                        </div>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={searchMode ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                            onClick={() => setSearchMode(m => !m)}
                        >
                            {searchMode ? "Close search" : "🔍 Search all"}
                        </Button>
                        <ScrollerThin className="vc-stalker-userlist" fade>
                            {ids.length === 0 && (
                                <div className="vc-stalker-empty">
                                    No tracked users. Right-click a user → “Track User (Stalker)”.
                                </div>
                            )}
                            {ids.map(id => {
                                const u = UserStore.getUser(id);
                                const entry = tracked[id];
                                const live = !!getLiveSession(id);
                                return (
                                    <div
                                        key={id}
                                        className={"vc-stalker-useritem" + (selected === id ? " active" : "")}
                                        onClick={() => setSelected(id)}
                                    >
                                        <div className="vc-stalker-useritem-name">
                                            {live && <span className="vc-stalker-sidebar-dot" title="In voice" />}
                                            {u?.globalName ?? u?.username ?? entry.username ?? id}
                                        </div>
                                        <div className="vc-stalker-useritem-id">{id}</div>
                                    </div>
                                );
                            })}
                        </ScrollerThin>
                    </div>
                    <div className="vc-stalker-main">
                        {searchMode
                            ? <GlobalSearchView onOpenUser={id => { setSelected(id); setSearchMode(false); }} />
                            : selected
                                ? <UserPanel userId={selected} />
                                : <div className="vc-stalker-empty">
                                    <Forms.FormText>Select or add a user.</Forms.FormText>
                                </div>}
                    </div>
                </div>
            </ModalContent>

            <ModalFooter>
                <div style={{ flexGrow: 1, color: hasNative() ? "var(--text-positive)" : "var(--text-danger)", fontSize: 12 }}>
                    {hasNative()
                        ? "Disk persistence: active"
                        : "Disk persistence: OFF — fully restart Discord to enable"}
                </div>
                <Button color={Button.Colors.PRIMARY} onClick={() => openDataDir()}>
                    Open data folder
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openStalkerModal(initialUserId?: string) {
    return openModal(props => (
        <StalkerModal props={props} initialUserId={initialUserId} />
    ));
}
