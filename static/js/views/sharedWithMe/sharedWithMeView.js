/**
 * OxiCloud – "Shared with me" view.
 *
 * Renders files and folders that other users have explicitly granted the
 * current user access to, using the cursor-paginated
 * `GET /api/grants/incoming/resources` endpoint.
 *
 * Uses `ResourceListComponent` so the grid ↔ list toggle and all card
 * components work out of the box. A "Load more" button is injected below
 * the files container for cursor-based pagination.
 */

import { ui } from '../../app/ui.js';
import { ResourceListComponent } from '../../components/resourceList.js';
import { createUserVignette } from '../../components/userVignette.js';
import { normalizeDateBucket } from '../../core/formatters.js';
import { i18n } from '../../core/i18n.js';
import * as viewPrefs from '../../core/viewPrefs.js';
import { batchToolbar } from '../../features/files/batchToolbar.js';
import * as itemTooltip from '../../features/itemTooltip.js';
import { favorites } from '../../features/library/favorites.js';
import { grants } from '../../model/grants.js';
import { systemUsers } from '../../model/systemUsers.js';
import { attachInfiniteScroll } from '../../utils/infiniteScroll.js';

/** @import {SharedWithMeItem, FileItem, FolderItem, ResourceTypeEnum} from '../../core/types.js' */

/**
 * @typedef {{ key: string, label: string, icon?: string, orderBy: string,
 *             keyFn?: (item: FileItem|FolderItem) => string|null,
 *             labelFn?: (key: string) => string,
 *             headerNodeFn?: (key: string) => HTMLElement }} GroupByDef
 */

/**
 * Group-by dimension definitions for this section.
 * Exported via `sharedWithMeView.groupByDefs` so `main.js` can populate
 * the dropdown dynamically without knowing the internals of this view.
 *
 * `keyFn` returns the grouping key (stable UUID for owner, or a
 * human-readable bucket label for shareDate — the bucket IS the key because
 * it is already derived from the date, so no separate `labelFn` is needed
 * for shareDate).
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
        // label is accessed via syncGroupByMenu → read at section-switch time,
        // when translations are guaranteed to be loaded.
        get label() {
            return i18n.t('groupby.owner', 'Owner');
        },
        icon: 'fas fa-layer-group',
        orderBy: 'granted_by',
        // keyFn groups by UUID — stable and unique, avoids collisions between
        // users with the same display name.
        keyFn: (item) => {
            const r = /** @type {Record<string,string>} */ (/** @type {unknown} */ (item));
            return r.owner_id || null;
        },
        // labelFn resolves UUID → display name from the pre-fetched cache.
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
        // keyFn: folders get their own swimlane; files use the pre-computed
        // `category` field from the DTO (e.g. 'Image', 'Video', 'Audio' …).
        // The server orders by category_order (a pre-computed SMALLINT column)
        // so items within the same category arrive grouped — no client sort needed.
        keyFn: (item) => ('mime_type' in item ? /** @type {Record<string,string>} */ (/** @type {unknown} */ (item)).category || 'other' : 'Folder'),
        labelFn: (key) => {
            // biome-ignore format: keep indentation
            /** @type {Record<string, string>} */
            const labels = {
                Folder:       i18n.t('groupby.type.folders', 'Folders'),
                Image:        i18n.t('category.images', 'Images'),
                Video:        i18n.t('category.videos', 'Videos'),
                Audio:        i18n.t('category.audio', 'Audio'),
                PDF:          'PDF',
                Document:     i18n.t('category.documents', 'Documents'),
                Spreadsheet:  i18n.t('category.spreadsheets', 'Spreadsheets'),
                Presentation: i18n.t('category.presentations', 'Presentations'),
                Archive:      i18n.t('category.archives', 'Archives'),
                Code:         i18n.t('category.code', 'Code'),
                Markdown:     i18n.t('category.markdown', 'Markdown'),
                Text:         i18n.t('category.text', 'Text'),
                Installer:    i18n.t('category.installers', 'Installers')
            };
            return labels[key] ?? key;
        }
    },
    // NOTE: there is no "Size" group-by here. The backend
    // (`grant_handler::list_incoming_resources` at line ~354) rejects
    // `sort_by=size` with a 400 — only `granted_at | granted_by | name |
    // type` are valid for the incoming endpoint. A `size` entry used to
    // live here and silently produced 400s on every selection. If you
    // need it back, also add the matching branch in
    // `pg_acl_engine::list_incoming_resources_paged` and widen the
    // handler's allowlist.
    {
        key: 'shareDate',
        get label() {
            return i18n.t('groupby.shareDate', 'Share date');
        },
        icon: 'fas fa-layer-group',
        orderBy: 'granted_at',
        // keyFn returns the human-readable bucket label; the label IS the key
        // because consecutive items with the same bucket should be in one group.
        // sort_date is stored as unix seconds (number) in _mapItems().
        keyFn: (item) => {
            const r = /** @type {Record<string,number>} */ (/** @type {unknown} */ (item));
            return r.sort_date ? normalizeDateBucket(r.sort_date) : null;
        }
        // No labelFn: keyFn already returns the human-readable label.
    }
];

/** ID of the "Load more" wrapper injected below `.files-container`. */
const LOAD_MORE_ID = 'swm-load-more-wrapper';

const sharedWithMeView = {
    // ── State ─────────────────────────────────────────────────────────────────

    /** @type {string|null} */
    _nextCursor: null,

    _loading: false,

    /** @type {ResourceListComponent|null} */
    _component: null,

    /**
     * Active group-by key. '' = no grouping, 'owner' | 'shareDate' = active.
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
     * @param {string} key  '' | 'owner' | 'shareDate'
     */
    setGroupBy(key) {
        if (this._groupBy === key) return;
        this._groupBy = key;
        viewPrefs.save('sharedwithme', this._groupBy, this._reversed, viewPrefs.load('sharedwithme').view);
        this._nextCursor = null; // restart from first page
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
        viewPrefs.save('sharedwithme', this._groupBy, this._reversed, viewPrefs.load('sharedwithme').view);
        this._nextCursor = null;
        this._component?.clear();
        this._loadPage();
    },

    /**
     * (Re-)load from page 1 and render into the existing files container.
     * Called every time the user switches to this section.
     */
    async init() {
        this._nextCursor = null;
        this._loading = false;
        const _savedPrefs = viewPrefs.load('sharedwithme');
        this._groupBy = _savedPrefs.groupBy;
        this._reversed = _savedPrefs.reversed;

        this._ensureLoadMoreButton();

        // Start fetching system users in background so tooltips resolve instantly
        // by the time the user hovers over an item.
        systemUsers.prefetch();

        // Standard files-view setup: clear list, show container
        ui.resetFilesList();
        batchToolbar.init();
        ui.updateBreadcrumb();

        // Create (or re-use) the component bound to #files-list.
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
     * Fetch one page, map items → FileItem / FolderItem, render them, then
     * wire the owner tooltip.
     * @returns {Promise<void>}
     */
    async _loadPage() {
        if (this._loading) return;
        this._loading = true;

        // Remember whether this is a fresh first-page load (cursor was null on
        // entry) so we know whether to replace or append items.
        const isFirstPage = this._nextCursor === null;

        try {
            const def = GROUP_BY_DEFS.find((d) => d.key === this._groupBy);

            // When no swimlane grouping is active, sort by resource name so the
            // list is alphabetical (same expectation as the Files section).
            // Group-by modes supply their own orderBy via the def.
            const orderBy = def?.orderBy ?? 'name';

            const data = await grants.fetchSharedWithMe({
                resourceTypes: /** @type {ResourceTypeEnum[]} */ (['file', 'folder']),
                limit: 50,
                cursor: this._nextCursor ?? undefined,
                orderBy,
                reverse: this._reversed
            });

            this._nextCursor = data.next_cursor ?? null;

            if (data.items.length === 0 && isFirstPage) {
                // First page came back empty
                ui.showError(`
                    <i class="fas fa-share-alt empty-state-icon"></i>
                    <p>${i18n.t('sharedwithme_emptyStateTitle', 'Nothing shared with you yet')}</p>
                    <p>${i18n.t('sharedwithme_emptyStateDesc', 'Items shared with you by other users will appear here')}</p>
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

            // Wire owner tooltips after items are in the DOM
            const filesList = document.getElementById('files-list');
            if (filesList) itemTooltip.init(filesList);

            // Fill the Owner column cells (idempotent: skips already-resolved rows).
            await this._component?.resolveOwnerCells();

            this._setLoadMoreVisible(!!this._nextCursor);
        } catch (err) {
            ui.showError(`
                <i class="fas fa-exclamation-circle empty-state-icon error"></i>
                <p>${i18n.t('errors_loadFailed', 'Failed to load items')}</p>
            `);
            console.error('sharedWithMeView: load error', err);
        } finally {
            this._loading = false;
        }
    },

    /**
     * Map `SharedWithMeItem[]` → a flat `(FileItem|FolderItem)[]` in
     * **server-returned order**.  The order must be preserved so that
     * swimlane grouping (group by owner / share date) works correctly when
     * the server interleaves files and folders by the sort key.
     *
     * Sets `owner_id` to `item.granted_by` so the component stamps
     * `data-owner-id` with the granter's user ID automatically.
     * Sets `sort_date` (unix seconds) to the grant date so the shareDate
     * `keyFn` buckets by when the share was created, not the resource's
     * own modification time.
     *
     * @param {SharedWithMeItem[]} items
     * @returns {Array<FileItem|FolderItem>}
     */
    _mapItems(items) {
        /** @type {Array<FileItem|FolderItem>} */
        const result = [];

        /** @param {string} iso @returns {number} */
        const grantedAtSecs = (iso) => Math.floor(new Date(iso).getTime() / 1000);

        for (const item of items) {
            if (item.resource_type === 'folder') {
                const f = /** @type {FolderItem} */ (item.resource);
                result.push(
                    /** @type {FolderItem} */ ({
                        id: f.id,
                        name: f.name,
                        path: f.path ?? '',
                        parent_id: f.parent_id ?? '',
                        owner_id: item.granted_by,
                        is_root: f.is_root ?? false,
                        created_at: f.created_at,
                        modified_at: f.modified_at,
                        sort_date: grantedAtSecs(item.granted_at),
                        icon_class: f.icon_class,
                        icon_special_class: f.icon_special_class ?? '',
                        category: 'folder',
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
                        owner_id: item.granted_by,
                        mime_type: f.mime_type,
                        size: f.size,
                        size_formatted: f.size_formatted,
                        created_at: f.created_at,
                        modified_at: f.modified_at,
                        sort_date: grantedAtSecs(item.granted_at),
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
        btn.id = 'swm-load-more';
        btn.className = 'button secondary';
        btn.textContent = i18n.t('sharedwithme_loadMore', 'Load more');
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

export { sharedWithMeView };
