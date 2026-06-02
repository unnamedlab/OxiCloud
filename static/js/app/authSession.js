/**
 * Authentication/session bootstrap and home-folder resolution
 */

import { getCsrfHeaders } from '../core/csrf.js';
import { updateStorageUsageDisplay } from './main.js';
import { app } from './state.js';
import { ui } from './ui.js';
import { updateUserMenuData } from './userMenu.js';

/**
 * @import {User} from '../core/types.js'
 */

/**
 *
 * @returns {Promise<User | null>}
 */
async function refreshUserData() {
    const USER_DATA_KEY = 'oxicloud_user';

    try {
        console.log('Fetching /api/auth/me (cookie-based)...');
        const response = await fetch('/api/auth/me', {
            method: 'GET',
            credentials: 'same-origin'
        });

        console.log('/api/auth/me response status:', response.status);

        if (!response.ok) {
            console.warn('Failed to fetch user data:', response.status);
            return null;
        }

        /** @type {User} */
        const userData = await response.json();
        console.log('Refreshed user data from server:', userData);
        console.log('Storage from server: used=', userData.storage_used_bytes, 'quota=', userData.storage_quota_bytes);

        localStorage.setItem(USER_DATA_KEY, JSON.stringify(userData));
        app.isExternalUser = !!userData.is_external;
        updateStorageUsageDisplay(userData);
        return userData;
    } catch (error) {
        console.error('Error refreshing user data:', error);
        return null;
    }
}

async function checkAuthentication() {
    try {
        const USER_DATA_KEY = 'oxicloud_user';

        const urlParams = new URLSearchParams(window.location.search);
        const oidcCode = urlParams.get('oidc_code');

        if (oidcCode) {
            console.log('OIDC exchange code detected, exchanging for tokens...');
            try {
                const exchangeResponse = await fetch('/api/auth/oidc/exchange', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
                    body: JSON.stringify({ code: oidcCode }),
                    credentials: 'same-origin'
                });

                if (!exchangeResponse.ok) {
                    const errText = await exchangeResponse.text();
                    console.error('OIDC token exchange failed:', exchangeResponse.status, errText);
                    window.location.href = '/login?source=oidc_error';
                    return;
                }

                const data = await exchangeResponse.json();
                console.log('OIDC token exchange successful');

                // Tokens are now in HttpOnly cookies set by the server.
                if (data.user) {
                    localStorage.setItem(USER_DATA_KEY, JSON.stringify(data.user));
                }

                window.history.replaceState({}, document.title, '/');
                window.location.reload();
                return;
            } catch (err) {
                console.error('OIDC exchange error:', err);
                window.location.href = '/login?source=oidc_error';
                return;
            }
        }

        // Check session validity by calling /api/auth/me (cookie auto-sent)
        console.log('Checking session via /api/auth/me...');

        /** @type {User} */
        /** @type {User} */
        const userData = JSON.parse(localStorage.getItem(USER_DATA_KEY) || '{}');
        // Restore the external-user flag eagerly from cache so the
        // resolveHomeFolder short-circuit fires before the /api/auth/me
        // refresh completes. The parse may produce a sparse object on
        // first load — `is_external` defaulting to falsy is correct
        // for the internal-user-by-default contract.
        app.isExternalUser = !!userData.is_external;
        if (userData.username) {
            // We have cached user data — render immediately, refresh in background
            updateUserMenuData();

            updateStorageUsageDisplay(userData);

            // Validate session BEFORE loading files to avoid 401 race condition
            const freshData = await refreshUserData();
            if (freshData) {
                console.log('Storage usage updated from server');
            } else {
                // Session expired — try silent refresh first
                console.warn('Session may have expired, trying refresh...');
                try {
                    const r = await fetch('/api/auth/refresh', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'application/json',
                            ...getCsrfHeaders()
                        },
                        body: '{}'
                    });
                    if (r.ok) {
                        await refreshUserData();
                    } else {
                        localStorage.removeItem(USER_DATA_KEY);
                        window.location.href = '/login?source=session_expired';
                        return;
                    }
                } catch (_err) {
                    localStorage.removeItem(USER_DATA_KEY);
                    window.location.href = '/login?source=session_expired';
                    return;
                }
            }
            await resolveHomeFolder();
            window.dispatchEvent(new CustomEvent('authenticationDone'));
        } else {
            // No cached user data — must verify session from server.
            // This is the first-load path for magic-link redemptions
            // (cookies set server-side, no prior localStorage).
            console.log('No cached user data, fetching from server');
            try {
                const freshData = await refreshUserData();
                if (freshData?.username) {
                    updateUserMenuData();
                    updateStorageUsageDisplay(freshData);
                    await resolveHomeFolder();
                    // Defer to the `authenticationDone` listener in main.js
                    // so the hash-driven section + path init runs in one
                    // place (was previously a `loadFiles()` here which
                    // bypassed the hash context and produced
                    // `/api/folders//resources` for external users).
                    window.dispatchEvent(new CustomEvent('authenticationDone'));
                } else {
                    console.warn('Could not retrieve user data, redirecting to login');
                    localStorage.removeItem(USER_DATA_KEY);
                    window.location.href = '/login?source=invalid_session';
                }
            } catch (err) {
                console.error('Failed to fetch user data:', err);
                localStorage.removeItem(USER_DATA_KEY);
                window.location.href = '/login?source=session_error';
            }
        }
    } catch (error) {
        console.error('Error during authentication check:', error);
        localStorage.removeItem('oxicloud_user');
        window.location.href = '/login?source=auth_error';
    }
}

async function resolveHomeFolder() {
    if (app.userHomeFolderId) return;
    // External users (grant-only recipients) do not own a home folder
    // by design — see `HomeFolderLifecycleHook::provision_if_needed`
    // which short-circuits on `is_external`. Skip the fetch + leave
    // `userHomeFolderId` null so downstream code knows to land them on
    // /#/sharedwithme instead of /files.
    if (app.isExternalUser) {
        console.log('External user — skipping home-folder resolution');
        app.breadcrumbPath = [];
        return;
    }
    try {
        const response = await fetch('/api/folders', {
            credentials: 'same-origin'
        });
        if (!response.ok) {
            console.warn(`Could not fetch home folder: ${response.status}`);
            return;
        }
        const folders = await response.json();
        const folderList = Array.isArray(folders) ? folders : [];
        if (folderList.length > 0) {
            const home = folderList[0];
            app.userHomeFolderId = home.id;
            app.userHomeFolderName = home.name;
            app.currentPath = home.id;
            app.breadcrumbPath = [];
            ui.updateBreadcrumb();
            console.log(`Home folder resolved: ${home.name} (${home.id})`);
        } else {
            console.warn('No root folders found for user');
            app.currentPath = '';
            app.breadcrumbPath = [];
            ui.updateBreadcrumb();
        }
    } catch (error) {
        console.error('Error resolving home folder:', error);
        app.currentPath = '';
        app.breadcrumbPath = [];
        ui.updateBreadcrumb();
    }
}

export { checkAuthentication, refreshUserData, resolveHomeFolder };
