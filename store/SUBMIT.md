# Submitting TabCrew to the Chrome Web Store

A checklist for the repository owner. Everything to paste lives in `store/listing.md` and `store/permissions.md`; images live in `store/assets/` and `store/screenshots/`.

## 0. Before the first submission (one time)

- [ ] Check the privacy policy loads publicly: <https://github.com/huynle/tabcrew/blob/main/docs/privacy.md>.
- [ ] **Register a Chrome Web Store developer account** at <https://chrome.google.com/webstore/devconsole>: sign in with the Google account that should own the item, accept the developer agreement, pay the one-time US$5 fee.
- [ ] **Complete account setup** (Account tab): publisher display name (e.g. "TabCrew" or your name), contact email, and verify that email. Complete identity / trader verification if the dashboard asks for it (it can take a few days). Optionally turn on 2-step verification (required for publishing on most accounts).
- [ ] **Enable private vulnerability reporting** on GitHub (Settings → Security → Private vulnerability reporting → Enable), as `SECURITY.md` points reporters there.

## 1. Build the package

From a clean checkout of the release tag (or download the zip attached to the GitHub release created by `.github/workflows/release.yml`):

```sh
npm ci
npm run build:store        # builds extension/dist-store/ and checks the zip
```

Upload file: `extension/tabcrew-extension-<version>.zip` (for 0.4.0: `extension/tabcrew-extension-0.4.0.zip`). The build check prints its contents and fails if the manifest has a `key`, if source maps are included, or if any script contains `eval`/`new Function`/remote code.

## 2. Create the item

- [ ] Developer Dashboard → **Items** → **New item** → upload the zip.

## 3. Store listing tab

Copy from `store/listing.md`:

- [ ] Description → the "Description" block.
- [ ] Category → Developer Tools. Language → English (United States).
- [ ] Store icon → `store/assets/icon-128.png`.
- [ ] Screenshots → `store/screenshots/1-sessions.png`, `2-placement.png`, `3-finished-group.png`, `4-agent-browse.png` (1280×800).
- [ ] Small promo tile → `store/screenshots/promo-small-440x280.png`.
- [ ] Homepage URL → `https://github.com/huynle/tabcrew`; Support URL → `https://github.com/huynle/tabcrew/issues`.
- [ ] Mature content → No.

## 4. Privacy tab

Copy from `store/permissions.md`:

- [ ] Single purpose description.
- [ ] One justification per permission: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `offscreen`, `nativeMessaging`, plus the optional host permissions (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`, requested at runtime in hub mode). There are no install-time host permissions. If the dashboard lists a permission not covered there, stop: the manifest changed and `store/permissions.md` must be updated first.
- [ ] Remote code → "No, I am not using remote code".
- [ ] Data usage → check **Web history** and **Website content** only; check all three certifications.
- [ ] Privacy policy URL → `https://github.com/huynle/tabcrew/blob/main/docs/privacy.md`.

## 5. Distribution tab

- [ ] Payments → Free.
- [ ] Visibility → Public.
- [ ] Regions → All regions.

## 6. Test instructions (optional but recommended)

- [ ] Paste the "Notes for reviewers" block from `store/permissions.md` into the test-instructions field (if offered).

## 7. Submit

- [ ] **Submit for review.** Leave "publish automatically after review" on, or turn it off to publish manually. `debugger` usually triggers an in-depth review that can take from a few days to a few weeks. Answer reviewer emails using the justifications above.

## 8. After approval

The store assigns a permanent 32-letter item ID (visible in the dashboard and in the item URL).

1. [x] Put the ID into `shared/src/product.ts`:
   ```ts
   export const TABCREW_EXTENSION_IDS: TabCrewExtensionIds = {
     dev: "aejgcpbbemekfbmmkabpbgdkgmddfamo",
     store: "<the 32-letter ID>",
   };
   export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/detail/tabcrew/<the 32-letter ID>";
   ```
2. [x] Replace the "Chrome Web Store listing pending" placeholder links in `README.md` and `cli/README.md` with the store URL.
3. [ ] Release a new CLI version so `tabcrew setup` registers the store ID in the pairing host's `allowed_origins` (until then, store installs cannot pair automatically; users can still paste the token from `npx tabcrew token` under the popup's **Advanced** section):
   ```sh
   node scripts/bump-version.mjs 0.4.1
   just release-check
   git commit -am "chore: release 0.4.1 with the Chrome Web Store ID"
   git tag v0.4.1 && git push && git push --tags
   ```
   The release workflow publishes `tabcrew` to npm and creates the GitHub release. Users then run `npx tabcrew@latest setup` (or `npx tabcrew update`). The same ID list is the hub's WebSocket Origin allowlist: until a release carries the store ID, a hub (`tabcrew mcp`) only accepts the unpacked build with the fixed dev ID.
4. [ ] Upload the new extension zip from that release to the store as an update (the version must increase with every store upload).

## Later updates

For every release that changes the extension: bump the version (`scripts/bump-version.mjs`), tag, let the workflow build the zip, upload it under the existing item → **Package** → **Upload new package**, and submit. If the manifest's permissions change, update `store/permissions.md` and the Privacy tab first.
