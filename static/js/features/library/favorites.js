/**
 * OxiCloud - Favorites Module (server-authoritative)
 *
 * Source of truth: GET /api/favorites/resources (cursor-paginated).
 * The in-memory cache (`_cache`) is a Set of "type:id" keys that keeps
 * `isFavorite()` synchronous so star icons are painted without a round-trip.
 *
 * Display is handled by `views/favorites/favoritesView.js`.
 */

import { ui } from '../../app/ui.js';
import { getCsrfHeaders } from '../../core/csrf.js';
import { i18n } from '../../core/i18n.js';
import { fetchFavoritesPage } from '../../model/favoritesModel.js';

const favorites = {
    /**
     * Set of "type:id" cache keys. A Set is enough — we only need O(1) lookups.
     * @type {Set<string>}
     */
    _cache: new Set(),

    /** Whether the initial fetch from the server has completed. */
    _ready: false,

    // ───────────────────── helpers ─────────────────────

    _authHeaders() {
        return { ...getCsrfHeaders() };
    },

    /**
     * @param {string} id
     * @param {string} type
     * @returns {string}
     */
    _cacheKey(id, type) {
        return `${type}:${id}`;
    },

    // ───────────────────── lifecycle ─────────────────────

    /**
     * Initialise the module: fetch the full favorites list from the server and
     * populate the in-memory cache.  Called from navigation.js every time the
     * Favorites section is entered (non-blocking — the view loads in parallel).
     */
    async init() {
        await this._fetchFromServer();
    },

    /**
     * Fetch all favorited resource IDs from the server and rebuild the cache.
     * Paginates through `GET /api/favorites/resources` until exhausted.
     */
    async _fetchFromServer() {
        try {
            this._cache.clear();

            let cursor = /** @type {string|undefined} */ (undefined);

            // Paginate with the max page size so most users need only one request.
            while (true) {
                const data = await fetchFavoritesPage({ limit: 200, cursor, orderBy: 'name' });
                for (const item of data.items) {
                    // `item.resource.id` works for both FileItem (id) and FolderItem (id).
                    const r = /** @type {Record<string, string>} */ (/** @type {unknown} */ (item.resource));
                    this._cache.add(this._cacheKey(r.id, item.resource_type));
                }
                if (!data.next_cursor) break;
                cursor = data.next_cursor;
            }

            this._ready = true;
            console.log(`Favorites cache loaded: ${this._cache.size} items`);
        } catch (err) {
            console.error('Error fetching favorites:', err);
        }
    },

    // ───────────────────── public API ─────────────────────

    /**
     * Synchronous check used by the rendering layer to paint star icons.
     * @param {string} id
     * @param {string} type
     * @returns {boolean}
     */
    isFavorite(id, type) {
        return this._cache.has(this._cacheKey(id, type));
    },

    /**
     * Add an item to favourites (server-first, then update local cache).
     * @param {string} id
     * @param {string} name
     * @param {string} type
     * @param {string | null} _parentId  - unused, kept for call-site compatibility
     * @returns {Promise<boolean>}
     */
    async addToFavorites(id, name, type, _parentId) {
        try {
            const response = await fetch(`/api/favorites/${type}/${id}`, {
                method: 'POST',
                headers: this._authHeaders()
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }

            // Optimistically update local cache without a full re-fetch.
            this._cache.add(this._cacheKey(id, type));

            if (ui?.showNotification) {
                ui.showNotification(i18n.t('favorites.added_title'), `"${name}" ${i18n.t('favorites.added_msg')}`);
            }

            return true;
        } catch (error) {
            console.error('Error adding to favorites:', error);
            return false;
        }
    },

    /**
     * Remove an item from favourites (server-first, then update local cache).
     * @param {string} id
     * @param {string} type
     * @param {string} [name]  - Display name for the notification; falls back to `id`.
     * @returns {Promise<boolean>}
     */
    async removeFromFavorites(id, type, name = id) {
        try {
            const response = await fetch(`/api/favorites/${type}/${id}`, {
                method: 'DELETE',
                headers: this._authHeaders()
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }

            this._cache.delete(this._cacheKey(id, type));

            if (ui?.showNotification) {
                ui.showNotification(i18n.t('favorites.removed_title'), `"${name}" ${i18n.t('favorites.removed_msg')}`);
            }

            return true;
        } catch (error) {
            console.error('Error removing from favorites:', error);
            return false;
        }
    },

    /**
     * Batch-add multiple items to favourites in a single server call.
     * Re-fetches the cache after success to stay consistent.
     *
     * @param {Array<{item_id: string, item_type: string}>} items
     * @returns {Promise<boolean>}
     */
    async batchAdd(items) {
        try {
            const response = await fetch('/api/favorites/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
                body: JSON.stringify({ items })
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }

            // Re-fetch the full cache so the Set reflects the latest server state.
            await this._fetchFromServer();

            return true;
        } catch (err) {
            console.error('Error in batchAdd:', err);
            return false;
        }
    }
};

export { favorites };
