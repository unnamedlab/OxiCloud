// @ts-check

/**
 * OxiCloud – Recent view.
 *
 * Renders files and folders the current user has recently accessed, using the
 * cursor-paginated `GET /api/recent/resources` endpoint.
 *
 * Default sort: `accessed_at` DESC (most recently accessed first, no swimlanes).
 * The user can pick any group-by from the dropdown; viewPrefs persists the choice.
 *
 * Public API mirrors `favoritesView`:
 *   - `groupByDefs`            — array of group-by dimension definitions
 *   - `setGroupBy(key)`        — change active dimension + reload from page 1
 *   - `setDirection(reversed)` — flip sort direction + reload from page 1
 *   - `init()`                 — (re-)enter the section; restores prefs + loads page 1
 *   - `hide()`                 — called when leaving this section
 */

import { ui } from '../../app/ui.js';
import { ResourceListComponent } from '../../components/resourceList.js';
import { createUserVignette } from '../../components/userVignette.js';
import { normalizeDateBucket, sizeBucket } from '../../core/formatters.js';
import { i18n } from '../../core/i18n.js';
import * as viewPrefs from '../../core/viewPrefs.js';
import { batchToolbar } from '../../features/files/batchToolbar.js';
import * as itemTooltip from '../../features/itemTooltip.js';
import { favorites } from '../../features/library/favorites.js';
import { fetchRecentPage } from '../../model/recentModel.js';
import { systemUsers } from '../../model/systemUsers.js';
import { attachInfiniteScroll } from '../../utils/infiniteScroll.js';

/** @import {FileItem, FolderItem, ResourceTypeEnum} from '../../core/types.js' */

/**
 * @typedef {{ key: string, label: string, icon?: string, orderBy: string,
 *             keyFn?: (item: FileItem|FolderItem) => string|null,
 *             labelFn?: (key: string) => string,
 *             headerNodeFn?: (key: string) => HTMLElement }} GroupByDef
 */

/**
 * @typedef {Object} RecentResourceItem
 * @property {ResourceTypeEnum}    resource_type
 * @property {string}              accessed_at
 * @property {FileItem|FolderItem} resource
 */

/**
 * Group-by dimension definitions for the Recent section.
 *
 * When `_groupBy === ''` (None selected), items are sorted by `accessed_at` DESC —
 * the natural expectation for a "Recent" section. "None" = flat chronological feed.
 *
 * @type {GroupByDef[]}
 */
const GROUP_BY_DEFS = [
    {
        key: '',
        get label() {
            return i18n.t('files.name', 'Name');
        },
        icon: 'fas fa-arrow-up-a-z',
        orderBy: 'name'
        // no keyFn → flat list.
    },
    {
        key: 'owner',
        get label() {
            return i18n.t('groupby.owner', 'Owner');
        },
        icon: 'fas fa-layer-group',
        orderBy: 'owner',
        keyFn: (item) => {
            const r = /** @type {Record<string,string>} */ (/** @type {unknown} */ (item));
            return r.owner_id || null;
        },
        labelFn: (id) => systemUsers.getDisplayNameSync(id),
        headerNodeFn: (id) => createUserVignette(id, 'sm')
    },
    {
        key: 'type',
        get label() {
            return i18n.t('groupby.type', 'Type');
        },
        icon: 'fas fa-layer-group',
        orderBy: 'type',
        keyFn: (item) => ('mime_type' in item ? /** @type {Record<string,string>} */ (/** @type {unknown} */ (item)).category || 'other' : 'Folder'),
        labelFn: (key) => {
            // biome-ignore format: keep indentation
            /** @type {Record<string, string>} */
            const labels = {
                Folder:       i18n.t('groupby.type.folders',     'Folders'),
                Image:        i18n.t('category.images',          'Images'),
                Video:        i18n.t('category.videos',          'Videos'),
                Audio:        i18n.t('category.audio',           'Audio'),
                PDF:          'PDF',
                Document:     i18n.t('category.documents',       'Documents'),
                Spreadsheet:  i18n.t('category.spreadsheets',    'Spreadsheets'),
                Presentation: i18n.t('category.presentations',   'Presentations'),
                Archive:      i18n.t('category.archives',        'Archives'),
                Code:         i18n.t('category.code',            'Code'),
                Markdown:     i18n.t('category.markdown',        'Markdown'),
                Text:         i18n.t('category.text',            'Text'),
                Installer:    i18n.t('category.installers',      'Installers')
            };
            return labels[key] ?? key;
        }
    },
    {
        key: 'size',
        get label() {
            return i18n.t('groupby.size', 'Size');
        },
        icon: 'fas fa-layer-group',
        orderBy: 'size',
        keyFn: (item) => {
            if (!('mime_type' in item)) return sizeBucket(-1);
            const r = /** @type {Record<string,number>} */ (/** @type {unknown} */ (item));
            return sizeBucket(r.size ?? 0);
        }
    },
    {
        key: 'accessedAt',
        get label() {
            return i18n.t('groupby.accessedAt', 'Accessed date');
        },
        icon: 'fas fa-layer-group',
        orderBy: 'accessed_at',
        // sort_date is unix seconds set in _mapItems(); keyFn returns the bucket label.
        keyFn: (item) => {
            const r = /** @type {Record<string,number>} */ (/** @type {unknown} */ (item));
            return r.sort_date ? normalizeDateBucket(r.sort_date) : null;
        }
    },
    {
        key: 'modifiedAt',
        get label() {
            return i18n.t('groupby.modifiedAt', 'Modified date');
        },
        icon: 'fas fa-layer-group',
        orderBy: 'modified_at',
        keyFn: (item) => {
            const r = /** @type {Record<string,number>} */ (/** @type {unknown} */ (item));
            return r.modified_at ? normalizeDateBucket(r.modified_at) : null;
        }
    }
];

/** ID of the "Load more" wrapper injected below `.files-container`. */
const LOAD_MORE_ID = 'recent-load-more-wrapper';

const recentView = {
    // ── State ─────────────────────────────────────────────────────────────────

    /** @type {string|null} */
    _nextCursor: null,

    _loading: false,

    /** @type {ResourceListComponent|null} */
    _component: null,

    /**
     * Active group-by key. '' = no grouping (sorted by accessed_at DESC).
     * @type {string}
     */
    _groupBy: '',

    /** Whether the current sort order is reversed. */
    _reversed: false,

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * The group-by dimension definitions for this section.
     * `main.js` reads this to populate the Group-by dropdown dynamically.
     * @returns {GroupByDef[]}
     */
    get groupByDefs() {
        return GROUP_BY_DEFS;
    },

    /**
     * Change the active group-by dimension and reload from page 1.
     * Calling with the current key is a no-op.
     * @param {string} key
     */
    setGroupBy(key) {
        if (this._groupBy === key) return;
        this._groupBy = key;
        viewPrefs.save('recent', this._groupBy, this._reversed, viewPrefs.load('recent').view);
        this._nextCursor = null;
        this._component?.clear();
        this._loadPage();
    },

    /**
     * Flip the sort direction and reload from page 1.
     * Calling with the current value is a no-op.
     * @param {boolean} reversed
     */
    setDirection(reversed) {
        if (this._reversed === reversed) return;
        this._reversed = reversed;
        viewPrefs.save('recent', this._groupBy, this._reversed, viewPrefs.load('recent').view);
        this._nextCursor = null;
        this._component?.clear();
        this._loadPage();
    },

    /**
     * (Re-)enter the Recent section: restore saved prefs, create / reuse the
     * component, and load page 1.
     */
    async init() {
        this._nextCursor = null;
        this._loading = false;
        const savedPrefs = viewPrefs.load('recent');
        this._groupBy = savedPrefs.groupBy;
        this._reversed = savedPrefs.reversed;

        this._ensureLoadMoreButton();

        // Prefetch system users so owner tooltips resolve without delay.
        systemUsers.prefetch();

        ui.resetFilesList();
        batchToolbar.init();
        ui.updateBreadcrumb();

        const filesList = document.getElementById('files-list');
        if (filesList) {
            if (!this._component) {
                this._component = new ResourceListComponent(/** @type {HTMLElement} */ (filesList), {
                    selectable: true,
                    showFavorite: true,
                    showOwner: true,
                    showShareBadge: false,
                    draggable: false,
                    showContextMenu: true,
                    isFavorite: (id, type) => favorites.isFavorite(id, type),
                    isShared: () => false,
                    onOpen: (item) => ui.openItem(item),
                    onFavoriteToggle: async (item) => {
                        const isFile = 'mime_type' in item;
                        const type = isFile ? 'file' : 'folder';
                        if (favorites.isFavorite(item.id, type)) {
                            await favorites.removeFromFavorites(item.id, type, item.name);
                            this._component?.setFavoriteVisualState(item.id, type, false);
                        } else {
                            await favorites.addToFavorites(item.id, item.name, type, null);
                            this._component?.setFavoriteVisualState(item.id, type, true);
                        }
                    },
                    onContextMenu: (item, e) => ui.showContextMenuForItem(item, e),
                    onSelectionChange: (selectedItems) => {
                        batchToolbar._selected.clear();
                        for (const sel of selectedItems) {
                            const isFile = 'mime_type' in sel;
                            batchToolbar._selected.set(sel.id, {
                                id: sel.id,
                                name: sel.name,
                                type: isFile ? 'file' : 'folder',
                                parentId: isFile ? /** @type {FileItem} */ (sel).folder_id || '' : /** @type {FolderItem} */ (sel).parent_id || ''
                            });
                        }
                        batchToolbar._syncUI();
                    }
                });
            }
            batchToolbar.setActiveComponent(this._component);
        }

        await this._loadPage();
    },

    /**
     * Hide the "Load more" button when leaving this section.
     * The files container itself is managed by navigation.js.
     */
    hide() {
        const w = document.getElementById(LOAD_MORE_ID);
        if (w) w.classList.add('hidden');

        batchToolbar.setActiveComponent(null);

        const filesList = document.getElementById('files-list');
        if (filesList) itemTooltip.destroy(filesList);
    },

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Fetch one page, map items → FileItem / FolderItem, render them.
     * @returns {Promise<void>}
     */
    async _loadPage() {
        if (this._loading) return;
        this._loading = true;

        const isFirstPage = this._nextCursor === null;

        try {
            const def = GROUP_BY_DEFS.find((d) => d.key === this._groupBy);
            // When no group-by is active, sort by accessed_at DESC (most recent first).
            const orderBy = def?.orderBy ?? 'accessed_at';

            const data = await fetchRecentPage({
                resourceTypes: /** @type {ResourceTypeEnum[]} */ (['file', 'folder']),
                limit: 50,
                cursor: this._nextCursor ?? undefined,
                orderBy,
                reverse: this._reversed
            });

            this._nextCursor = data.next_cursor ?? null;

            if (data.items.length === 0 && isFirstPage) {
                ui.showError(`
                    <i class="fas fa-clock empty-state-icon"></i>
                    <p>${i18n.t('recent.empty_state', 'No recent files')}</p>
                    <p>${i18n.t('recent.empty_hint', 'Files you open will appear here')}</p>
                `);
                this._setLoadMoreVisible(false);
                return;
            }

            const items = this._mapItems(data.items);

            if (isFirstPage) {
                this._component?.render(items, def?.keyFn, def?.labelFn, def?.headerNodeFn);
            } else {
                this._component?.append(items, def?.keyFn, def?.labelFn, def?.headerNodeFn);
            }

            // Wire unified item tooltip (owner + path) after items are in the DOM.
            const filesList = document.getElementById('files-list');
            if (filesList) itemTooltip.init(filesList);

            await this._component?.resolveOwnerCells();

            this._setLoadMoreVisible(!!this._nextCursor);
        } catch (err) {
            ui.showError(`
                <i class="fas fa-exclamation-circle empty-state-icon error"></i>
                <p>${i18n.t('errors_loadFailed', 'Failed to load items')}</p>
            `);
            console.error('recentView: load error', err);
        } finally {
            this._loading = false;
        }
    },

    /**
     * Map `RecentResourceItem[]` → a flat `(FileItem|FolderItem)[]` preserving
     * server order. Sets `sort_date` (unix seconds) to the `accessed_at` date
     * so the `accessedAt` keyFn can bucket by when the item was accessed.
     *
     * @param {RecentResourceItem[]} items
     * @returns {Array<FileItem|FolderItem>}
     */
    _mapItems(items) {
        /** @type {Array<FileItem|FolderItem>} */
        const result = [];

        /** @param {string} iso @returns {number} unix seconds */
        const toSecs = (iso) => Math.floor(new Date(iso).getTime() / 1000);

        for (const item of items) {
            if (item.resource_type === 'folder') {
                const f = /** @type {FolderItem} */ (item.resource);
                result.push(
                    /** @type {FolderItem} */ ({
                        id: f.id,
                        name: f.name,
                        path: f.path ?? '',
                        parent_id: f.parent_id ?? '',
                        owner_id: f.owner_id ?? '',
                        is_root: f.is_root ?? false,
                        created_at: f.created_at,
                        modified_at: f.modified_at,
                        // sort_date = accessed_at (unix seconds) for the accessedAt keyFn
                        sort_date: toSecs(item.accessed_at),
                        icon_class: f.icon_class,
                        icon_special_class: f.icon_special_class ?? '',
                        category: 'Folder',
                        etag: ''
                    })
                );
            } else if (item.resource_type === 'file') {
                const f = /** @type {FileItem} */ (item.resource);
                result.push(
                    /** @type {FileItem} */ ({
                        id: f.id,
                        name: f.name,
                        path: f.path ?? '',
                        folder_id: f.folder_id ?? '',
                        owner_id: f.owner_id ?? '',
                        mime_type: f.mime_type,
                        size: f.size,
                        size_formatted: f.size_formatted,
                        created_at: f.created_at,
                        modified_at: f.modified_at,
                        sort_date: toSecs(item.accessed_at),
                        icon_class: f.icon_class,
                        icon_special_class: f.icon_special_class ?? '',
                        category: f.category,
                        etag: '',
                        content_hash: ''
                    })
                );
            }
        }

        return result;
    },

    // ── "Load more" button ────────────────────────────────────────────────────

    /**
     * Create the "Load more" wrapper once and attach it below `.files-container`.
     * Subsequent calls are no-ops.
     */
    _ensureLoadMoreButton() {
        if (document.getElementById(LOAD_MORE_ID)) return;

        const filesContainer = document.querySelector('.files-container');
        if (!filesContainer) return;

        const wrapper = document.createElement('div');
        wrapper.id = LOAD_MORE_ID;
        wrapper.className = 'swm-load-more-wrapper hidden';

        const btn = document.createElement('button');
        btn.id = 'recent-load-more';
        btn.className = 'button secondary';
        btn.textContent = i18n.t('recent.loadMore', 'Load more');
        btn.addEventListener('click', () => this._loadPage());

        wrapper.appendChild(btn);
        filesContainer.after(wrapper);

        attachInfiniteScroll(wrapper, () => this._loadPage());
    },

    /**
     * @param {boolean} visible
     */
    _setLoadMoreVisible(visible) {
        const w = document.getElementById(LOAD_MORE_ID);
        if (w) w.classList.toggle('hidden', !visible);
    }
};

export { recentView };
