import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import { getPlaylistsApi } from '@jellyfin/sdk/lib/utils/api/playlists-api';
import { getUserLibraryApi } from '@jellyfin/sdk/lib/utils/api/user-library-api';
import escapeHtml from 'escape-html';

import toast from 'components/toast/toast';
import { PluginType } from 'constants/pluginType';
import dom from 'utils/dom';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { currentSettings as userSettings } from 'scripts/settings/userSettings';
import { toApi } from 'utils/jellyfin-apiclient/compat';
import { isBlank } from 'utils/string';

import dialogHelper from '../dialogHelper/dialogHelper';
import loading from '../loading/loading';
import layoutManager from '../layoutManager';
import { playbackManager } from '../playback/playbackmanager';
import { pluginManager } from '../pluginManager';
import { appRouter } from '../router/appRouter';

import 'elements/emby-button/emby-button';
import 'elements/emby-checkbox/emby-checkbox';
import 'elements/emby-input/emby-input';
import 'elements/emby-button/paper-icon-button-light';

import 'material-design-icons-iconfont';
import '../formdialog.scss';
import './playlisteditor.scss';

interface DialogElement extends HTMLDivElement {
    playlistId?: string
    submitted?: boolean
}

interface PlaylistEditorOptions {
    items: string[],
    id?: string,
    serverId: string,
    enableAddToPlayQueue?: boolean,
    defaultValue?: string
}

let currentServerId: string;

function onSubmit(this: HTMLElement, e: Event) {
    e.preventDefault();

    const panel = dom.parentWithClass(this, 'dialog') as DialogElement | null;

    if (!panel) {
        console.error('[PlaylistEditor] Dialog element is missing!');
        return;
    }

    // Edit existing playlist
    if (panel.playlistId) {
        loading.show();
        updatePlaylist(panel)
            .catch(err => {
                console.error('[PlaylistEditor] Failed to update playlist %s', panel.playlistId, err);
                toast(globalize.translate('PlaylistError.UpdateFailed'));
            })
            .finally(loading.hide);
        return;
    }

    const itemIds = panel.querySelector<HTMLInputElement>('.fldSelectedItemIds')?.value;

    // Standalone create-new-playlist mode (no items being added)
    if (!itemIds) {
        loading.show();
        createPlaylist(panel)
            .catch(err => {
                console.error('[PlaylistEditor] Failed to create playlist', err);
                toast(globalize.translate('PlaylistError.CreateFailed'));
            })
            .finally(loading.hide);
        return;
    }

    // Add-to-playlist mode: collect all checked targets
    const checkedIds = Array.from(
        panel.querySelectorAll<HTMLInputElement>('.chkPlaylist:checked')
    ).map(cb => cb.value);

    const createNew = panel.querySelector<HTMLInputElement>('#chkCreateNewPlaylist')?.checked;

    if (!checkedIds.length && !createNew) {
        return;
    }

    loading.show();

    const ops: Promise<void>[] = checkedIds.map(id => addToPlaylist(panel, id));

    if (createNew) {
        ops.push(createPlaylist(panel, false));
    }

    // Persist last used playlist for pre-selection next time
    const lastId = checkedIds.find(id => id !== 'queue');
    if (lastId) {
        userSettings.set('playlisteditor-lastplaylistid', lastId);
    }

    void Promise.allSettled(ops)
        .then(results => {
            const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

            failures.forEach(({ reason }) => {
                console.error('[PlaylistEditor] Failed to add to playlist(s)', reason);
            });

            if (failures.length) {
                toast(globalize.translate('PlaylistError.AddFailed'));
            }

            // Close if at least one operation succeeded
            if (failures.length < results.length) {
                panel.submitted = true;
                dialogHelper.close(panel);
            }
        })
        .finally(loading.hide);
}

function createPlaylist(dlg: DialogElement, redirect = true): Promise<void> {
    const name = dlg.querySelector<HTMLInputElement>('#txtNewPlaylistName')?.value;
    if (isBlank(name)) return Promise.reject(new Error('Playlist name should not be blank'));

    const apiClient = ServerConnections.getApiClient(currentServerId);
    const api = toApi(apiClient);

    const itemIds = dlg.querySelector<HTMLInputElement>('.fldSelectedItemIds')?.value || undefined;

    return getPlaylistsApi(api)
        .createPlaylist({
            createPlaylistDto: {
                Name: name ?? '',
                IsPublic: dlg.querySelector<HTMLInputElement>('#chkPlaylistPublic')?.checked,
                Ids: itemIds?.split(','),
                UserId: apiClient.getCurrentUserId()
            }
        })
        .then(result => {
            if (redirect) {
                dlg.submitted = true;
                dialogHelper.close(dlg);

                redirectToPlaylist(result.data.Id);
            }
        });
}

function redirectToPlaylist(id: string | undefined) {
    appRouter.showItem(id, currentServerId);
}

function updatePlaylist(dlg: DialogElement) {
    if (!dlg.playlistId) return Promise.reject(new Error('Missing playlist ID'));

    const name = dlg.querySelector<HTMLInputElement>('#txtNewPlaylistName')?.value;
    if (isBlank(name)) return Promise.reject(new Error('Playlist name should not be blank'));

    const apiClient = ServerConnections.getApiClient(currentServerId);
    const api = toApi(apiClient);

    return getPlaylistsApi(api)
        .updatePlaylist({
            playlistId: dlg.playlistId,
            updatePlaylistDto: {
                Name: name,
                IsPublic: dlg.querySelector<HTMLInputElement>('#chkPlaylistPublic')?.checked
            }
        })
        .then(() => {
            dlg.submitted = true;
            dialogHelper.close(dlg);
        });
}

function addToPlaylist(dlg: DialogElement, id: string): Promise<void> {
    const apiClient = ServerConnections.getApiClient(currentServerId);
    const api = toApi(apiClient);
    const itemIds = dlg.querySelector<HTMLInputElement>('.fldSelectedItemIds')?.value || '';

    if (id === 'queue') {
        return Promise.resolve(playbackManager.queue({
            serverId: currentServerId,
            ids: itemIds.split(',')
        })).then(() => undefined);
    }

    return getPlaylistsApi(api)
        .addItemToPlaylist({
            playlistId: id,
            ids: itemIds.split(','),
            userId: apiClient.getCurrentUserId()
        })
        .then(() => undefined);
}

function toggleNewPlaylistForm(panel: ParentNode, show: boolean) {
    panel.querySelector('.newPlaylistInfo')?.classList.toggle('hide', !show);

    const nameField = panel.querySelector('#txtNewPlaylistName');
    if (show) {
        nameField?.setAttribute('required', 'required');
    } else {
        nameField?.removeAttribute('required');
    }
}

function populatePlaylists(editorOptions: PlaylistEditorOptions, panel: DialogElement) {
    const container = panel.querySelector<HTMLDivElement>('#playlistCheckboxList');

    if (!container) {
        return Promise.reject(new Error('Playlist list container element is missing'));
    }

    loading.show();

    toggleNewPlaylistForm(panel, false);

    const apiClient = ServerConnections.getApiClient(currentServerId);
    const api = toApi(apiClient);
    const SyncPlay = pluginManager.firstOfType(PluginType.SyncPlay)?.instance;

    return getItemsApi(api)
        .getItems({
            userId: apiClient.getCurrentUserId(),
            includeItemTypes: [ BaseItemKind.Playlist ],
            sortBy: [ ItemSortBy.SortName ],
            recursive: true,
            enableUserData: false
        })
        .then(({ data }) => {
            return Promise.all((data.Items || []).map(item => {
                const playlist = {
                    item,
                    permissions: undefined
                };

                if (!item.Id) return playlist;

                return getPlaylistsApi(api)
                    .getPlaylistUser({
                        playlistId: item.Id,
                        userId: apiClient.getCurrentUserId()
                    })
                    .then(({ data: permissions }) => ({
                        ...playlist,
                        permissions
                    }))
                    .catch(err => {
                        // If a user doesn't have access, then the request will 404 and throw
                        console.info('[PlaylistEditor] Failed to fetch playlist permissions', err);

                        return playlist;
                    });
            }));
        })
        .then(playlists => {
            let html = '';

            if ((editorOptions.enableAddToPlayQueue !== false && playbackManager.isPlaying()) || SyncPlay?.Manager.isSyncPlayEnabled()) {
                html += `<label>
                    <input type="checkbox" is="emby-checkbox" class="chkPlaylist" value="queue" />
                    <span>${globalize.translate('AddToPlayQueue')}</span>
                </label>`;
            }

            playlists.forEach(({ item, permissions }) => {
                if (!permissions?.CanEdit) return;

                html += `<label>
                    <input type="checkbox" is="emby-checkbox" class="chkPlaylist" value="${item.Id}" />
                    <span>${escapeHtml(item.Name ?? '')}</span>
                </label>`;
            });

            container.innerHTML = html;

            // Pre-select the last used playlist
            let defaultValue = editorOptions.defaultValue;
            if (!defaultValue) {
                defaultValue = userSettings.get('playlisteditor-lastplaylistid') || '';
            }
            if (defaultValue && defaultValue !== 'new') {
                container.querySelectorAll<HTMLInputElement>('.chkPlaylist').forEach(checkbox => {
                    if (checkbox.value === defaultValue) checkbox.checked = true;
                });
            }

            // Show/hide the new-playlist form when the "Create new" checkbox is toggled
            panel.querySelector('#chkCreateNewPlaylist')?.addEventListener('change', function(this: HTMLInputElement) {
                toggleNewPlaylistForm(panel, this.checked);
                if (this.checked) {
                    panel.querySelector<HTMLInputElement>('#txtNewPlaylistName')?.focus();
                }
            });
        });
}

function getEditorHtml(items: string[], options: PlaylistEditorOptions) {
    let html = '';

    html += '<div class="formDialogContent smoothScrollY" style="padding-top:2em;">';
    html += '<div class="dialogContentInner dialog-content-centered">';
    html += '<form style="margin:auto;">';

    html += '<div class="newPlaylistOption checkboxList">';
    html += `<label>
        <input type="checkbox" is="emby-checkbox" id="chkCreateNewPlaylist" />
        <span>${globalize.translate('OptionNew')}</span>
    </label>`;
    html += '</div>';

    html += '<div class="newPlaylistInfo">';

    html += '<div class="inputContainer">';
    const autoFocus = items.length ? '' : ' autofocus';
    html += `<input is="emby-input" type="text" id="txtNewPlaylistName" required="required" label="${globalize.translate('LabelName')}"${autoFocus} />`;
    html += '</div>';

    html += `
    <div class="checkboxContainer checkboxContainer-withDescription">
        <label>
            <input type="checkbox" is="emby-checkbox" id="chkPlaylistPublic" />
            <span>${globalize.translate('PlaylistPublic')}</span>
        </label>
        <div class="fieldDescription checkboxFieldDescription">
            ${globalize.translate('PlaylistPublicDescription')}
        </div>
    </div>`;

    // newPlaylistInfo
    html += '</div>';

    html += '<div class="fldSelectPlaylist">';
    html += '<div id="playlistCheckboxList" class="checkboxList playlistCheckboxList"></div>';
    html += '</div>';

    html += '<div class="formDialogFooter">';
    html += `<button is="emby-button" type="submit" class="raised btnSubmit block formDialogFooterItem button-submit">${options.id ? globalize.translate('Save') : globalize.translate('Add')}</button>`;
    html += '</div>';

    html += '<input type="hidden" class="fldSelectedItemIds" />';

    html += '</form>';
    html += '</div>';
    html += '</div>';

    return html;
}

function initEditor(content: DialogElement, options: PlaylistEditorOptions, items: string[]) {
    content.querySelector('form')?.addEventListener('submit', onSubmit);

    const selectedItemsInput = content.querySelector<HTMLInputElement>('.fldSelectedItemIds');
    if (selectedItemsInput) {
        selectedItemsInput.value = items.join(',');
    }

    if (items.length) {
        content.querySelector('.fldSelectPlaylist')?.classList.remove('hide');
        populatePlaylists(options, content)
            .catch(err => {
                console.error('[PlaylistEditor] failed to populate playlists', err);
            })
            .finally(loading.hide);
    } else if (options.id) {
        content.querySelector('.fldSelectPlaylist')?.classList.add('hide');
        content.querySelector('.newPlaylistOption')?.classList.add('hide');
        const panel = dom.parentWithClass(content, 'dialog') as DialogElement | null;
        if (!panel) {
            console.error('[PlaylistEditor] could not find dialog element');
            return;
        }

        const apiClient = ServerConnections.getApiClient(currentServerId);
        const api = toApi(apiClient);
        Promise.all([
            getUserLibraryApi(api)
                .getItem({ itemId: options.id }),
            getPlaylistsApi(api)
                .getPlaylist({ playlistId: options.id })
        ])
            .then(([ { data: playlistItem }, { data: playlist } ]) => {
                panel.playlistId = options.id;

                const nameField = panel.querySelector<HTMLInputElement>('#txtNewPlaylistName');
                if (nameField) nameField.value = playlistItem.Name || '';

                const publicField = panel.querySelector<HTMLInputElement>('#chkPlaylistPublic');
                if (publicField) publicField.checked = !!playlist.OpenAccess;
            })
            .catch(err => {
                console.error('[playlistEditor] failed to get playlist details', err);
            });
    } else {
        // Standalone create-new-playlist mode
        content.querySelector('.fldSelectPlaylist')?.classList.add('hide');
        content.querySelector('.newPlaylistOption')?.classList.add('hide');
    }
}

function centerFocus(elem: HTMLDivElement | null, horiz: boolean, on: boolean) {
    if (!elem) {
        console.error('[PlaylistEditor] cannot focus null element');
        return;
    }

    import('../../scripts/scrollHelper')
        .then((scrollHelper) => {
            const fn = on ? 'on' : 'off';
            scrollHelper.centerFocus[fn](elem, horiz);
        })
        .catch(err => {
            console.error('[PlaylistEditor] failed to load scroll helper', err);
        });
}

export class PlaylistEditor {
    show(options: PlaylistEditorOptions) {
        const items = options.items || [];
        currentServerId = options.serverId;

        const dialogOptions = {
            removeOnClose: true,
            scrollY: false,
            size: layoutManager.tv ? 'fullscreen' : 'small'
        };

        const dlg: DialogElement = dialogHelper.createDialog(dialogOptions);

        dlg.classList.add('formDialog');

        let html = '';
        html += '<div class="formDialogHeader">';
        html += `<button is="paper-icon-button-light" class="btnCancel autoSize" tabindex="-1" title="${globalize.translate('ButtonBack')}"><span class="material-icons arrow_back" aria-hidden="true"></span></button>`;
        html += '<h3 class="formDialogHeaderTitle">';
        if (items.length) {
            html += globalize.translate('HeaderAddToPlaylist');
        } else if (options.id) {
            html += globalize.translate('HeaderEditPlaylist');
        } else {
            html += globalize.translate('HeaderNewPlaylist');
        }
        html += '</h3>';

        html += '</div>';

        html += getEditorHtml(items, options);

        dlg.innerHTML = html;

        initEditor(dlg, options, items);

        dlg.querySelector('.btnCancel')?.addEventListener('click', () => {
            dialogHelper.close(dlg);
        });

        if (layoutManager.tv) {
            centerFocus(dlg.querySelector('.formDialogContent'), false, true);
        }

        return dialogHelper.open(dlg).then(() => {
            if (layoutManager.tv) {
                centerFocus(dlg.querySelector('.formDialogContent'), false, false);
            }

            if (dlg.submitted) {
                return Promise.resolve();
            }

            return Promise.reject(new Error());
        });
    }
}

export default PlaylistEditor;
