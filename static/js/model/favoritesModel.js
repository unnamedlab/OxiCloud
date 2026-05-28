/**
 * OxiCloud – Favorites resource model.
 *
 * Thin fetch wrapper for `GET /api/favorites/resources` (cursor-paginated).
 * The old `GET /api/favorites` endpoint is kept for the isFavorite cache in
 * `features/library/favorites.js` — this module only handles the new endpoint.
 */

/** @import {FileItem, FolderItem, ResourceTypeEnum} from '../core/types.js' */

/**
 * @typedef {Object} FavoritesResourceItem
 * @property {ResourceTypeEnum}    resource_type  - 'file' | 'folder'
 * @property {string}              favorited_at   - ISO-8601 timestamp
 * @property {FileItem|FolderItem} resource       - Full resource details
 */

/**
 * @typedef {Object} FavoritesResourcesResponse
 * @property {FavoritesResourceItem[]}  items
 * @property {string|undefined}         [next_cursor]
 */

/**
 * Fetch one page of the current user's favorited resources.
 *
 * @param {{
 *   cursor?:        string,
 *   orderBy?:       string,
 *   limit?:         number,
 *   reverse?:       boolean,
 *   resourceTypes?: ResourceTypeEnum[],
 * }} [opts]
 * @returns {Promise<FavoritesResourcesResponse>}
 */
async function fetchFavoritesPage({ cursor, orderBy = 'name', limit = 50, reverse = false, resourceTypes } = {}) {
    const params = new URLSearchParams({ order_by: orderBy, limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (reverse) params.set('reverse', 'true');
    if (resourceTypes?.length) params.set('resource_types', resourceTypes.join(','));

    const res = await fetch(`/api/favorites/resources?${params}`);
    if (!res.ok) {
        const err = new Error(`Failed to fetch favorites: HTTP ${res.status}`);
        /** @type {any} */ (err).status = res.status;
        throw err;
    }
    return res.json();
}

export { fetchFavoritesPage };
